import { randomBytes } from "node:crypto";
import { decidePermission, DEFAULT_SAFE_COMMANDS, opencodePermissionConfig, type Policy } from "./decide.js";

export interface RunPromptArgs {
  client: any;                 // @opencode-ai/sdk client (injected; real one from getServer())
  sessionId?: string;
  model: string;               // "google-vertex-ai/gemini-2.5-flash"
  prompt: string;
  allow: string[];
  /** auto = Tweaklet decides risky actions (denies them); ask = the person in the panel decides. Default ask. */
  mode?: Policy["mode"];
  safeCommands?: string[];
  /** The repo opencode is editing, for symlink-aware edit checks. Defaults to
   *  the directory the running opencode server was spawned in. */
  repoRoot?: string;
  onEvent: (e: any) => void;
  onAsk: (req: { permissionID: string; permission: string; patterns: string[]; diff?: string }) => Promise<"approve" | "deny">;
  signal?: AbortSignal;
  graceMs?: number;            // trailing-event grace after prompt resolves (default 1000; tests pass small)
}
export interface RunPromptResult { sessionId: string; blocked: string[] }

export async function runPrompt(a: RunPromptArgs): Promise<RunPromptResult> {
  const slash = a.model.indexOf("/");
  const providerID = slash >= 0 ? a.model.slice(0, slash) : "";
  const modelID = slash >= 0 ? a.model.slice(slash + 1) : a.model;

  let sessionId = a.sessionId;
  if (!sessionId) {
    const s = await a.client.session.create({ body: { title: "Tweaklet" } });
    sessionId = s?.data?.id ?? s?.id;
  }
  const blocked: string[] = [];
  const policy: Policy = {
    allow: a.allow,
    mode: a.mode ?? "ask",
    safeCommands: a.safeCommands ?? DEFAULT_SAFE_COMMANDS,
    // opencode resolves edit paths against the dir it was spawned in, so that
    // is the right root whenever the caller doesn't name one.
    repoRoot: a.repoRoot ?? _ocDir ?? undefined,
  };
  const events = await a.client.event.subscribe();
  if (a.signal) {
    a.signal.addEventListener("abort", () => { a.client.session.abort({ path: { id: sessionId } }).catch(() => {}); }, { once: true });
  }

  const pump = (async () => {
    for await (const ev of events.stream) {
      const t = ev?.type;
      const p = ev?.properties ?? {};
      if (t === "permission.asked" && p.sessionID && p.sessionID !== sessionId) {
        // A request from another session (e.g. a subagent) — nothing supervises
        // it, so fail closed rather than leaving it hanging.
        await a.client.postSessionIdPermissionsPermissionId({ path: { id: p.sessionID, permissionID: p.id }, body: { response: "reject" } }).catch(() => {});
        continue;
      }
      if (p.sessionID && p.sessionID !== sessionId) continue;
      if (t === "permission.asked") {
        const decision = decidePermission(p, policy);
        let response: "once" | "reject";
        if (decision === "approve") response = "once";
        else if (decision === "deny") {
          response = "reject";
          if (Array.isArray(p.patterns)) blocked.push(...p.patterns);
          a.onEvent({ type: "denied", permission: p.permission, patterns: p.patterns ?? [], raw: {} });
        } else {
          const r = await a.onAsk({ permissionID: p.id, permission: p.permission, patterns: p.patterns ?? [], diff: p?.metadata?.diff });
          response = r === "approve" ? "once" : "reject";
          if (r !== "approve" && Array.isArray(p.patterns)) blocked.push(...p.patterns);
        }
        await a.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: p.id }, body: { response } }).catch(() => {});
      } else if (t === "session.idle") {
        break;
      } else if (t === "session.error") {
        a.onEvent({ type: "error", message: JSON.stringify(p).slice(0, 300), raw: p });
      } else {
        a.onEvent({ type: t, raw: p });
      }
    }
  })();

  await a.client.session.prompt({
    path: { id: sessionId },
    body: { model: { providerID, modelID }, agent: "assistant", parts: [{ type: "text", text: a.prompt }] },
    // Surface a rejected prompt (e.g. "Model not found", "Agent not found",
    // ADC/auth failures) instead of swallowing it — a silent catch here is what
    // let those errors slip past setup and only appear on the user's first tweak.
  }).catch((e: any) => { a.onEvent({ type: "error", message: String(e?.message ?? e).slice(0, 300), raw: e }); });
  await Promise.race([pump, new Promise((r) => setTimeout(r, a.graceMs ?? 1000))]);
  return { sessionId: sessionId as string, blocked };
}

/**
 * Run a trivial prompt end-to-end to prove the agent actually answers with the
 * configured provider/model/agent — NOT just that the opencode server is up.
 * Catches "Model not found", "Agent not found", and ADC/auth failures DURING
 * setup instead of on the user's first real tweak. Denies any tool the model
 * might request (a text reply needs none) and bounds the wait with a timeout.
 */
export async function smokeTestAgent(args: { client: any; model: string; timeoutMs?: number }): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 45000);
  let errorMsg = "";
  try {
    await runPrompt({
      client: args.client,
      model: args.model,
      prompt: "Reply with exactly the single word: ok",
      allow: [],                          // deny all tools; a text reply needs none
      onAsk: async () => "deny",          // defensive: never approve a tool in a smoke test
      onEvent: (e) => { if (e?.type === "error" && !errorMsg) errorMsg = String(e.message ?? "agent error").slice(0, 300); },
      signal: ctrl.signal,
      graceMs: 1500,
    });
  } catch (e: any) {
    if (!errorMsg) errorMsg = String(e?.message ?? e).slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
  if (ctrl.signal.aborted && !errorMsg) errorMsg = "agent did not respond within the timeout";
  return errorMsg ? { ok: false, detail: errorMsg } : { ok: true, detail: "agent replied to a test prompt" };
}

/** The two @opencode-ai/sdk entry points startOpencode needs (injectable for tests). */
export interface OpencodeSdk {
  createOpencodeServer: (options: any) => Promise<{ url: string; close: () => void }>;
  createOpencodeClient: (config: any) => any;
}

const OPENCODE_USER = "opencode";

/**
 * Start `opencode serve` so only this process can drive it.
 *
 * SECURITY: opencode's HTTP API can run shell commands, edit files and answer
 * its own permission prompts. Unauthenticated, anything that can reach the
 * port (another local user, or an SSRF in the host app) could use it. opencode
 * enforces HTTP Basic auth on every route when OPENCODE_SERVER_PASSWORD is set,
 * so each spawn gets a fresh random password and only our client knows it.
 *
 * The SDK spawns the child with `{ ...process.env }` and offers no env option,
 * so the secret is put in our env just for the synchronous spawn (which happens
 * before createOpencodeServer's first await) and taken out again immediately.
 * Loopback only, on a free port (opencode prefers 4096 when port is 0, else
 * any free port; the SDK reads the real URL from opencode's startup line).
 */
export async function startOpencode(sdk: OpencodeSdk, config: Record<string, unknown>): Promise<{ client: any; server: any }> {
  const password = randomBytes(32).toString("base64url");
  const saved = { password: process.env.OPENCODE_SERVER_PASSWORD, username: process.env.OPENCODE_SERVER_USERNAME };
  let pending: Promise<{ url: string; close: () => void }>;
  try {
    process.env.OPENCODE_SERVER_PASSWORD = password;
    process.env.OPENCODE_SERVER_USERNAME = OPENCODE_USER;
    pending = sdk.createOpencodeServer({ hostname: "127.0.0.1", port: 0, config });
  } finally {
    restoreEnv("OPENCODE_SERVER_PASSWORD", saved.password);
    restoreEnv("OPENCODE_SERVER_USERNAME", saved.username);
  }
  const server = await pending;
  const client = sdk.createOpencodeClient({
    baseUrl: server.url,
    headers: { Authorization: "Basic " + Buffer.from(`${OPENCODE_USER}:${password}`).toString("base64") },
  });
  return { client, server };
}
function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Real server singleton (NOT used in unit tests — they inject a fake client).
//
// opencode derives its PROJECT ROOT (where it loads `.opencode/agent/*.md` and
// which files it edits) from the directory the server process is SPAWNED in.
// We must spawn it in the cloned repo (`projectDir` = config.repo.path), NOT the
// tweaklet service's launch dir — otherwise it can't find the repo's agents
// (e.g. "assistant") and would edit the wrong tree. Because the clone happens
// per-user AFTER startup, we re-spawn opencode whenever the project dir changes.
let _oc: { client: any; server: any } | null = null;
let _ocDir: string | null = null;
// In-flight creation, so concurrent callers (e.g. the startup warm-up AND the
// panel's on-mount /agent/history) share ONE opencode server instead of
// spawning two (each with its own password). Keyed by target dir so a dir
// change still re-spawns.
let _ocCreating: { dir: string; promise: Promise<{ client: any; server: any }> } | null = null;
export async function getServer(projectDir?: string): Promise<{ client: any; server: any }> {
  const { existsSync } = await import("node:fs");
  // Resolve the project dir to spawn opencode in:
  //  - an explicit, existing projectDir wins (the agent's clone — where it edits
  //    + finds its agents);
  //  - WITHOUT one (e.g. the doctor's "is opencode up?" probe), REUSE whatever's
  //    already running (`_ocDir`) instead of defaulting to process.cwd(). A
  //    no-arg caller defaulting to cwd was thrashing opencode between the clone
  //    and the service dir (a stopServer + respawn on every probe). A probe
  //    doesn't care which dir; it wants the running server.
  const target = projectDir && existsSync(projectDir) ? projectDir : (_ocDir ?? process.cwd());
  if (_oc && _ocDir === target) return _oc;
  if (_ocCreating && _ocCreating.dir === target) return _ocCreating.promise; // share the in-flight spawn
  console.log(`[getServer] spawning opencode in ${target} (was: ${_ocDir ?? "none"})`);
  const promise = (async () => {
    if (_oc) await stopServer();            // project dir changed → restart opencode there
    const sdk = await import("@opencode-ai/sdk");
    const prev = process.cwd();
    try {
      // The spawned opencode child inherits this cwd; restore the parent's cwd
      // afterwards so nothing else in the service is affected (the child keeps the
      // cwd it was forked with).
      process.chdir(target);
      // Force every tool use through Tweaklet's permission policy, whatever the
      // host repo's own opencode config says (inline config wins).
      _oc = await startOpencode(sdk as unknown as OpencodeSdk, opencodePermissionConfig());
      _ocDir = target;
    } finally {
      process.chdir(prev);
    }
    return _oc;
  })();
  _ocCreating = { dir: target, promise };
  try { return await promise; }
  finally { if (_ocCreating?.promise === promise) _ocCreating = null; }
}
export async function stopServer(): Promise<void> { try { _oc?.server?.close?.(); } catch {} _oc = null; _ocDir = null; }
