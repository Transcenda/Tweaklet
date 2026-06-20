import { decidePermission } from "./decide.js";

export interface RunPromptArgs {
  client: any;                 // @opencode-ai/sdk client (injected; real one from getServer())
  sessionId?: string;
  model: string;               // "google-vertex-ai/gemini-2.5-flash"
  prompt: string;
  allow: string[];
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
  const events = await a.client.event.subscribe();
  if (a.signal) {
    a.signal.addEventListener("abort", () => { a.client.session.abort({ path: { id: sessionId } }).catch(() => {}); }, { once: true });
  }

  const pump = (async () => {
    for await (const ev of events.stream) {
      const t = ev?.type;
      const p = ev?.properties ?? {};
      if (p.sessionID && p.sessionID !== sessionId) continue;
      if (t === "permission.asked") {
        const decision = decidePermission(p, a.allow);
        let response: "once" | "reject";
        if (decision === "approve") response = "once";
        else if (decision === "deny") { response = "reject"; if (Array.isArray(p.patterns)) blocked.push(...p.patterns); }
        else {
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
// panel's on-mount /agent/history) share ONE createOpencode. opencode binds a
// FIXED port (4096) — without this, two simultaneous getServer() calls while
// `_oc` is still null both spawn opencode and the second dies with a port
// collision ("ServeError"). Keyed by target dir so a dir change still re-spawns.
let _ocCreating: { dir: string; promise: Promise<{ client: any; server: any }> } | null = null;
export async function getServer(projectDir?: string): Promise<{ client: any; server: any }> {
  const { existsSync } = await import("node:fs");
  // Resolve the project dir to spawn opencode in:
  //  - an explicit, existing projectDir wins (the agent's clone — where it edits
  //    + finds its agents);
  //  - WITHOUT one (e.g. the doctor's "is opencode up?" probe), REUSE whatever's
  //    already running (`_ocDir`) instead of defaulting to process.cwd(). A
  //    no-arg caller defaulting to cwd was thrashing opencode between the clone
  //    and the service dir → stopServer + a second `createOpencode` on the fixed
  //    port 4096 → "ServeError". A probe doesn't care which dir; it wants the
  //    running server.
  const target = projectDir && existsSync(projectDir) ? projectDir : (_ocDir ?? process.cwd());
  if (_oc && _ocDir === target) return _oc;
  if (_ocCreating && _ocCreating.dir === target) return _ocCreating.promise; // share the in-flight spawn
  console.log(`[getServer] spawning opencode in ${target} (was: ${_ocDir ?? "none"})`);
  const promise = (async () => {
    if (_oc) await stopServer();            // project dir changed → restart opencode there
    const { createOpencode } = await import("@opencode-ai/sdk");
    const prev = process.cwd();
    try {
      // The spawned opencode child inherits this cwd; restore the parent's cwd
      // afterwards so nothing else in the service is affected (the child keeps the
      // cwd it was forked with).
      process.chdir(target);
      _oc = await createOpencode();
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
