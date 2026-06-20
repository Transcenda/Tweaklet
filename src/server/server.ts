import express, { type Request, type Response, type NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { TweakletConfig, TweakletConfigInput } from "../config/config.js";
import {
  ConfigSchema,
  loadConfig as realLoadConfig,
  saveConfig as realSaveConfig,
} from "../config/config.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken as realExchange,
  fetchGithubUser as realFetchUser,
  type GithubUser,
} from "../auth/github-oauth.js";
import { ghCliUser as realGhCliUser } from "../auth/gh-cli.js";
import { sign, verify } from "../auth/signing.js";
import type { AgentEvent } from "../agent/events.js";
import { fetchSessionMessages as realFetchSessionMessages, messagesToEvents } from "../agent/history.js";
import { runPrompt as realRunPrompt, getServer, stopServer, smokeTestAgent as realSmokeTestAgent } from "../agent/opencode-server.js";
import { ensureOpencodeProvider } from "../agent/provider-config.js";
import { mountDomMcp } from "../agent/mcp-server.js";
import { makeSessionStore } from "./session-store.js";
import type { SessionStore } from "./session-store.js";
import { setActivePrompt, resolveDomInspect, type DomResult } from "../agent/dom-inspect.js";
import * as repoLib from "../git/repo.js";
import * as prLib from "../git/pr.js";
import { refresh as realRefresh } from "../run/live-update.js";
import { runDiagnostics as realRunDiagnostics } from "../doctor/doctor.js";
import { cloneAllowedRepo } from "../repo/clone.js";
import { ensurePreview as realEnsurePreview } from "../run/preview.js";
import { computeSetupState } from "./setup-state.js";

export interface ServerDeps {
  exchangeCodeForToken?: typeof realExchange;
  fetchGithubUser?: typeof realFetchUser;
  ghCliUser?: typeof realGhCliUser;
  runPrompt?: typeof realRunPrompt;
  getClient?: () => Promise<any>;
  /** Injectable agent smoke-test (real prompt round-trip) for verify-agent; stubbed in tests. */
  smokeTestAgent?: typeof realSmokeTestAgent;
  lifecycle?: {
    startBranch: typeof repoLib.startBranch;
    currentBranch: typeof repoLib.currentBranch;
    checkpoint: typeof repoLib.checkpoint;
    discard: typeof repoLib.discard;
    reject: typeof repoLib.reject;
    branchState: typeof repoLib.branchState;
    isDirty: typeof repoLib.isDirty;
    previewCommit: typeof repoLib.previewCommit;
    exitPreview: typeof repoLib.exitPreview;
    restoreCommit: typeof repoLib.restoreCommit;
    refresh: typeof realRefresh;
    createDraftPr: typeof prLib.createDraftPr;
    prStatus: typeof prLib.prStatus;
    repoSlugFromRemote: typeof prLib.repoSlugFromRemote;
  };
  runDiagnostics?: typeof realRunDiagnostics;
  loadConfig?: () => TweakletConfig;
  saveConfig?: (cfg: TweakletConfigInput) => void;
  cloneRepo?: typeof cloneAllowedRepo;
  /** Injectable live-preview (re)start for /agent/clone; stubbed in tests. */
  ensurePreview?: typeof realEnsurePreview;
  /**
   * Injectable fetch function for the verify-embed and verify-agent routes.
   * Defaults to the global `fetch`. Provide a stub in tests to avoid real
   * HTTP calls.
   */
  verifyFetch?: typeof fetch;
  /**
   * Injectable setup token — use in tests to provide a known value instead of
   * the randomly generated one. Only read when setup.completed === false.
   */
  setupToken?: string;
  /** Injectable session store (login→sessionId). Defaults to a durable
   *  JSON file at ${TWEAKLET_HOME}/sessions.json. Inject a no-op store in
   *  tests to avoid writing to ~/.tweaklet during the test suite. */
  sessionStore?: SessionStore;
  /** Injectable opencode message fetch (for re-hydrating /agent/history). Stubbed in tests. */
  fetchSessionMessages?: typeof realFetchSessionMessages;
}

const SESSION_COOKIE = "apz_session";
const STATE_COOKIE = "apz_oauth_state";

/**
 * Validate a guardrailsAllow entry.
 * Rejects absolute paths, path-traversal patterns, and over-broad globs.
 */
function validateGuardrailsEntry(entry: string): boolean {
  if (typeof entry !== "string") return false;
  if (entry.startsWith("/")) return false;           // absolute path
  if (entry.includes("..")) return false;            // path traversal
  if (entry === "**" || entry === "/**") return false; // over-broad glob
  return true;
}

function isAllowed(user: { login?: string; id?: number }, config: TweakletConfig): boolean {
  const logins = config.access?.allowedLogins;
  const ids = config.access?.allowedUserIds;
  // No allowlist configured → open (a startup warning is emitted by `serve`).
  if ((!logins || logins.length === 0) && (!ids || ids.length === 0)) return true;
  const loginOk = !!logins && !!user.login && logins.some((l) => l.toLowerCase() === user.login!.toLowerCase());
  const idOk = !!ids && typeof user.id === "number" && ids.includes(user.id);
  return loginOk || idOk;
}

function isLoopback(req: { ip?: string; socket?: { remoteAddress?: string } }): boolean {
  const addr = req.ip || req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr === "" || addr === undefined;
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createServer(config: TweakletConfig, deps: ServerDeps = {}) {
  // The opencode SDK spawns the bare `opencode` binary; if the configured command is an
  // absolute path, make sure its directory is on PATH so the spawn resolves.
  if (config.agent?.command?.startsWith("/")) {
    const d = dirname(config.agent.command);
    if (!(process.env.PATH ?? "").split(":").includes(d)) process.env.PATH = `${d}:${process.env.PATH ?? ""}`;
  }
  const exchange = deps.exchangeCodeForToken ?? realExchange;
  const fetchUser = deps.fetchGithubUser ?? realFetchUser;
  const ghUser = deps.ghCliUser ?? realGhCliUser;
  const doRun = deps.runPrompt ?? realRunPrompt;
  // Spawn/Use opencode in the cloned repo (so it resolves the repo's agents +
  // edits the repo), NOT the service's launch dir. Re-points if repo.path changes.
  const getClient = deps.getClient ?? (async () => (await getServer(config.repo?.path)).client);
  const runDiag = deps.runDiagnostics ?? realRunDiagnostics;
  const doLoadConfig = deps.loadConfig ?? realLoadConfig;
  const doSaveConfig = deps.saveConfig ?? realSaveConfig;
  const doCloneRepo = deps.cloneRepo ?? cloneAllowedRepo;
  const doEnsurePreview = deps.ensurePreview ?? realEnsurePreview;
  const doSmokeTest = deps.smokeTestAgent ?? realSmokeTestAgent;
  const doFetch = deps.verifyFetch ?? fetch;
  const doFetchMessages = deps.fetchSessionMessages ?? realFetchSessionMessages;
  const tweakletHome = process.env.TWEAKLET_HOME && process.env.TWEAKLET_HOME.length > 0
    ? process.env.TWEAKLET_HOME : join(homedir(), ".tweaklet");
  const sessions = deps.sessionStore ?? makeSessionStore(join(tweakletHome, "sessions.json"));
  const tokenStore = new Map<string, { token: string; name: string; email: string }>();
  function currentToken(req: Request): { token: string; name: string; email: string } | null {
    const u = currentUser(req);
    return u ? tokenStore.get(u.login) ?? null : null;
  }
  const pendingAsks = new Map<string, { owner: string; resolve: (r: "approve" | "deny") => void }>();
  let agentRunning = false;
  let currentAbort: AbortController | null = null;
  let previewing: string | null = null;
  let lastBranch: string | null = null;
  const lc = deps.lifecycle ?? {
    startBranch: repoLib.startBranch,
    currentBranch: repoLib.currentBranch,
    checkpoint: repoLib.checkpoint,
    discard: repoLib.discard,
    reject: repoLib.reject,
    branchState: repoLib.branchState,
    isDirty: repoLib.isDirty,
    previewCommit: repoLib.previewCommit,
    exitPreview: repoLib.exitPreview,
    restoreCommit: repoLib.restoreCommit,
    refresh: realRefresh,
    createDraftPr: prLib.createDraftPr,
    prStatus: prLib.prStatus,
    repoSlugFromRemote: prLib.repoSlugFromRemote,
  };

  // ── One-time setup token ───────────────────────────────────────────────────
  // Generated once when setup is not yet completed; compared with timingSafeEqual.
  // Exposed via ServerDeps.setupToken so tests can inject a known value.
  // The token becomes moot once setup.completed flips to true (routes return 410).
  const activeSetupToken: string | null = config.setup.completed
    ? null
    : (deps.setupToken ?? randomBytes(24).toString("base64url"));

  function requireRepo(res: Response): boolean {
    if (!config.repo) { res.status(400).json({ error: "no repo configured" }); return false; }
    if (!config.repo.path) { res.status(409).json({ error: "no repo cloned yet" }); return false; }
    return true;
  }
  const secret = config.server.sessionSecret;
  const basePath = config.server.basePath ?? "/tweaklet";
  const redirectUri = `${config.server.publicUrl}${basePath}/auth/callback`;
  const app = express();
  app.use(express.json());

  function currentUser(req: Request): GithubUser | null {
    const tok = parseCookies(req)[SESSION_COOKIE];
    return tok ? verify<GithubUser>(tok, secret) : null;
  }

  function authGate(req: Request, res: Response, next: NextFunction) {
    if (currentUser(req)) return next();
    res.status(401).json({ error: "unauthorized" });
  }

  // Create a router for all tweaklet routes mounted under basePath
  const router = express.Router();

  // ── Setup routes ────────────────────────────────────────────────────────────
  // Only active while setup has not been completed; return 410 Gone once
  // config.setup.completed is true.
  //
  // While unconfigured they require a one-time setup token (printed to stdout on
  // startup) to prevent a stranger on the network from injecting OAuth creds or
  // cloning a repo before the operator has configured the server.

  function loadFresh(): TweakletConfig {
    try {
      return doLoadConfig();
    } catch {
      // No config file yet — treat as a blank uncompleted setup.
      // Re-parse through Zod to apply all defaults and return a fully-independent object.
      return ConfigSchema.parse(config);
    }
  }

  // Keep the long-lived in-memory `config` (closed over by the /auth and /agent
  // routes) in sync with what the setup wizard just wrote to disk. Without this,
  // creds saved via /setup/* don't take effect until a process restart — e.g.
  // /auth/login would keep seeing `config.github === undefined` right after the
  // GitHub step was saved. Mutates in place (config is a const object) so every
  // closure sees the update.
  function refreshConfig(): void {
    Object.assign(config, loadFresh());
  }

  // NOTE: setupLockGuard and the route handlers each call doLoadConfig() independently.
  // For a local single-user tool this TOCTOU is acceptable — a concurrent /setup/complete
  // between the guard read and the handler read is extremely unlikely and benign (the
  // handler will read completed=true from loadFresh and return a consistent response).
  function setupLockGuard(_req: Request, res: Response, next: NextFunction) {
    try {
      const cfg = doLoadConfig();
      if (cfg.setup.completed) {
        res.status(410).json({ error: "setup already completed" });
        return;
      }
    } catch {
      // No config file yet — setup hasn't run, allow through.
    }
    next();
  }

  /**
   * Require the setup token via x-tweaklet-setup-token header (or
   * Authorization: Bearer <token>).  Compares with timingSafeEqual to
   * prevent timing attacks.
   * Returns 403 when missing or wrong; passes through when correct.
   */
  function setupAuthGuard(req: Request, res: Response, next: NextFunction) {
    if (!activeSetupToken) {
      // Setup already completed at server start — setupLockGuard will 410 first,
      // but be defensive.
      next();
      return;
    }
    const header =
      req.headers["x-tweaklet-setup-token"] ??
      (req.headers["authorization"]?.startsWith("Bearer ")
        ? req.headers["authorization"].slice(7)
        : undefined);
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) {
      res.status(403).json({ error: "setup token required" });
      return;
    }
    // timingSafeEqual requires equal-length buffers.
    const a = Buffer.from(provided);
    const b = Buffer.from(activeSetupToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: "setup token required" });
      return;
    }
    next();
  }

  // GET /setup/state
  router.get("/setup/state", setupLockGuard, setupAuthGuard, async (_req, res) => {
    const cfg = loadFresh();
    const checks = await runDiag(cfg);
    const state = computeSetupState(cfg, checks);
    res.json({ ...state, checks, allowlist: cfg.repo?.allowlist ?? [] });
  });

  // POST /setup/github
  router.post("/setup/github", setupLockGuard, setupAuthGuard, async (req, res) => {
    const { clientId, clientSecret } = req.body ?? {};
    if (!clientId || !clientSecret) {
      res.status(400).json({ error: "clientId and clientSecret are required" });
      return;
    }
    const cfg = loadFresh();
    cfg.github = {
      clientId,
      clientSecret,
      oauthBaseUrl: cfg.github?.oauthBaseUrl ?? "https://github.com",
      apiBaseUrl: cfg.github?.apiBaseUrl ?? "https://api.github.com",
    };
    doSaveConfig(cfg);
    refreshConfig();
    const freshCfg = loadFresh();
    const checks = await runDiag(freshCfg);
    res.json({ ...computeSetupState(freshCfg, checks), checks, allowlist: freshCfg.repo?.allowlist ?? [] });
  });

  // POST /setup/agent
  router.post("/setup/agent", setupLockGuard, setupAuthGuard, async (req, res) => {
    const { vertexProject, vertexLocation, model, command } = req.body ?? {};
    const cfg = loadFresh();
    cfg.agent = {
      command: command ?? cfg.agent?.command ?? "opencode",
      cwd: cfg.agent?.cwd ?? process.cwd(),
      vertexProject: vertexProject ?? cfg.agent?.vertexProject,
      vertexLocation: vertexLocation ?? cfg.agent?.vertexLocation,
      model: model ?? cfg.agent?.model,
    };
    doSaveConfig(cfg);
    // Write opencode's provider config so the configured Vertex model resolves
    // on a from-scratch box (no hand-written ~/.config/opencode/opencode.json).
    try { ensureOpencodeProvider(cfg.agent ?? {}, { port: cfg.server.port, basePath: cfg.server.basePath }); } catch (e) { console.warn("Tweaklet: could not write opencode provider config:", String(e)); }
    refreshConfig();
    const freshCfg = loadFresh();
    const checks = await runDiag(freshCfg);
    res.json({ ...computeSetupState(freshCfg, checks), checks, allowlist: freshCfg.repo?.allowlist ?? [] });
  });

  // POST /setup/repo
  router.post("/setup/repo", setupLockGuard, setupAuthGuard, async (req, res) => {
    const allowlist = req.body?.allowlist;
    if (!Array.isArray(allowlist) || allowlist.some((r: unknown) => typeof r !== "string")) {
      res.status(400).json({ error: "allowlist must be an array of repo refs" }); return;
    }
    const cfg = loadFresh();
    cfg.repo = { ...(cfg.repo ?? { path: "", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: [] }), allowlist };
    doSaveConfig(cfg);
    refreshConfig();
    const checks = await runDiag(loadFresh());
    res.json({ ...computeSetupState(loadFresh(), checks), checks, allowlist });
  });

  // POST /setup/doctor
  router.post("/setup/doctor", setupLockGuard, setupAuthGuard, async (_req, res) => {
    const cfg = loadFresh();
    const checks = await runDiag(cfg);
    res.json({ ...computeSetupState(cfg, checks), checks, allowlist: cfg.repo?.allowlist ?? [] });
  });

  // GET /setup/verify-embed — is the panel actually embedded + reachable in the host app?
  router.get("/setup/verify-embed", setupLockGuard, setupAuthGuard, async (_req, res) => {
    const root = config.server.publicUrl.replace(/\/+$/, "") + "/";
    const widgetUrl = `${config.server.publicUrl.replace(/\/+$/, "")}${basePath}/widget.js`;
    let embedded = false, widgetReachable = false, detail = "";
    try {
      const hostRes = await doFetch(root, { redirect: "follow" } as any);
      const html = await hostRes.text();
      embedded = html.includes(`${basePath}/widget.js`) || /tweaklet\/widget\.js/.test(html);
    } catch (e) { detail = `could not fetch host app: ${String(e)}`; }
    try {
      const wRes = await doFetch(widgetUrl, { method: "GET" } as any);
      widgetReachable = (wRes as any).status === 200;
    } catch { /* leave false */ }
    res.json({ embedded, widgetReachable, hostUrl: root, detail });
  });

  // GET /setup/verify-agent — is the agent ready under the signed-in user?
  router.get("/setup/verify-agent", setupLockGuard, setupAuthGuard, async (req, res) => {
    const tok = currentToken(req);
    const cfg = loadFresh();
    const checks = await runDiag(cfg);
    const opencodeOk = checks.find((c) => c.name === "opencode")?.status === "ok";
    const repoCloned = !!cfg.repo?.path && existsSync(join(cfg.repo.path, ".git"));
    // The real gate: actually prompt the agent. "opencode responds" is not
    // "the agent answers with the configured provider/model" — only a round-trip
    // catches Model/Agent-not-found + ADC failures here, not on the first tweak.
    let agentReplies = false, agentDetail = "";
    if (!!tok && opencodeOk && repoCloned) {
      try {
        const client = await getClient();
        const r = await doSmokeTest({ client, model: cfg.agent?.model ?? "google-vertex-ai/gemini-2.5-pro" });
        agentReplies = r.ok; agentDetail = r.detail;
      } catch (e) { agentDetail = String(e); }
    }
    const ready = !!tok && opencodeOk && repoCloned && agentReplies;
    res.json({
      ready,
      signedIn: !!tok,
      opencodeOk,
      repoCloned,
      agentReplies,
      detail: ready ? "agent ready"
        : !tok ? "sign in first"
        : !repoCloned ? "no repo cloned yet"
        : !opencodeOk ? "opencode not responding"
        : `agent did not answer a test prompt: ${agentDetail}`,
    });
  });

  // POST /setup/complete — requires an active session
  router.post("/setup/complete", setupLockGuard, setupAuthGuard, async (req, res) => {
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: "must be signed in to complete setup" });
      return;
    }
    const cfg = loadFresh();
    const checks = await runDiag(cfg);
    const state = computeSetupState(cfg, checks);
    const incomplete = state.steps.filter((s) => s.status === "todo");
    if (incomplete.length > 0) {
      res.status(409).json({ error: "setup incomplete", incompleteSteps: incomplete.map((s) => s.id) });
      return;
    }
    cfg.setup = { completed: true };
    doSaveConfig(cfg);
    refreshConfig();
    res.json({ completed: true });
  });

  // ── Auth + agent routes ──────────────────────────────────────────────────────

  router.get("/auth/cli", async (req, res) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: "cli auth is local-only; sign in via GitHub OAuth from a remote host" });
      return;
    }
    const user = await ghUser();
    if (!user) {
      if (config.github) return res.redirect(`${basePath}/auth/login`);
      res.status(400).json({ error: "gh CLI is not authenticated (run `gh auth login`), and no GitHub OAuth is configured" });
      return;
    }
    if (!isAllowed(user, config)) {
      res.status(403).json({ error: "not authorized", detail: `${user.login} is not on the access allowlist` });
      return;
    }
    res.cookie(SESSION_COOKIE, sign(user, secret), { httpOnly: true, sameSite: "lax", path: "/" });
    res.redirect(`${basePath}/`);
  });

  router.get("/auth/login", (_req, res) => {
    if (!config.github) {
      res.status(400).json({ error: "GitHub OAuth is not configured yet — complete the 'GitHub OAuth' step in setup (paste your OAuth App's Client ID + Secret) before signing in." });
      return;
    }
    const state = randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, sign({ state }, secret), { httpOnly: true, sameSite: "lax", path: "/" });
    res.redirect(
      buildAuthorizeUrl({
        clientId: config.github.clientId,
        redirectUri,
        state,
        oauthBaseUrl: config.github.oauthBaseUrl,
      }),
    );
  });

  router.get("/auth/callback", async (req, res) => {
    if (!config.github) {
      res.status(400).json({ error: "GitHub OAuth is not configured yet — complete the 'GitHub OAuth' step in setup (paste your OAuth App's Client ID + Secret) before signing in." });
      return;
    }
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const signed = parseCookies(req)[STATE_COOKIE];
    const expected = signed ? verify<{ state: string }>(signed, secret) : null;
    if (!code || !expected || expected.state !== state) {
      res.status(400).json({ error: "invalid oauth state" });
      return;
    }
    try {
      const token = await exchange({
        code,
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        redirectUri,
        oauthBaseUrl: config.github.oauthBaseUrl,
      });
      const user = await fetchUser({ token, apiBaseUrl: config.github.apiBaseUrl });
      if (!isAllowed(user, config)) {
        res.clearCookie(STATE_COOKIE, { path: "/" });
        res.status(403).json({ error: "not authorized", detail: `${user.login} is not on the access allowlist` });
        return;
      }
      tokenStore.set(user.login, { token, name: user.name, email: user.email });
      res.cookie(SESSION_COOKIE, sign(user, secret), { httpOnly: true, sameSite: "lax", path: "/" });
      res.clearCookie(STATE_COOKIE, { path: "/" });
      // If opened in a popup the page notifies the opener and closes itself.
      // If visited directly (non-popup) it falls back to a normal redirect.
      res.type("html").send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Tweaklet — signed in</title></head><body>` +
        `<script>` +
        `if(window.opener){` +
          `window.opener.postMessage({type:"tweaklet:signed-in"},window.location.origin);` +
          `window.close();` +
        `}else{` +
          `window.location.replace(${JSON.stringify(basePath + "/")});` +
        `}` +
        `</script>` +
        `<p>Signed in — you may close this window.</p>` +
        `</body></html>`,
      );
    } catch (e) {
      res.status(502).json({ error: "oauth failed", detail: String(e) });
    }
  });

  router.post("/auth/logout", (req, res) => {
    const u = currentUser(req); if (u) tokenStore.delete(u.login);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  router.get("/agent/me", authGate, (req, res) => {
    res.json(currentUser(req));
  });

  router.get("/agent/repos", authGate, (_req, res) => {
    res.json({ allowlist: config.repo?.allowlist ?? [], cloned: !!config.repo?.path });
  });

  router.get("/agent/doctor", authGate, async (_req, res) => {
    res.json({ checks: await runDiag(config) });
  });

  router.post("/agent/prompt", authGate, async (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!config.agent) {
      res.status(400).json({ error: "no agent configured" });
      return;
    }
    if (!config.agent.model) {
      res.status(400).json({ error: "no agent model configured" });
      return;
    }
    if (!prompt) {
      res.status(400).json({ error: "empty prompt" });
      return;
    }
    if (agentRunning) {
      res.status(409).json({ error: "an agent run is already in progress" });
      return;
    }
    const user = currentUser(req)!;
    agentRunning = true;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (e: AgentEvent | { type: "end"; code: number }) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    // Wire the DOM-inspect round-trip for this turn: the MCP `dom_query` tool
    // emits a `dom_inspect` SSE frame via this `send`, the widget answers via
    // POST /agent/dom-result → resolveDomInspect. Cleared in the finally below.
    const domPending = new Map<string, (r: DomResult) => void>();
    setActivePrompt({ send: (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`), pending: domPending });
    currentAbort = new AbortController();
    const onAsk = (r: { permissionID: string; permission: string; patterns: string[]; diff?: string }) =>
      new Promise<"approve" | "deny">((resolve) => {
        pendingAsks.set(r.permissionID, { owner: user.login, resolve });
        send({ type: "permission_ask", permissionID: r.permissionID, permission: r.permission, patterns: r.patterns, diff: r.diff } as any);
      });
    try {
      const client = await getClient();
      const { sessionId, blocked } = await doRun({
        client,
        sessionId: sessions.get(user.login),
        model: config.agent!.model!,
        prompt,
        allow: config.guardrails.allow,
        onEvent: send,
        onAsk,
        signal: currentAbort.signal,
      });
      sessions.set(user.login, sessionId);
      if (blocked.length) send({ type: "guardrail", blocked, raw: {} } as any);
      send({ type: "end", code: 0 });
    } catch (e) {
      send({ type: "error", message: String(e), raw: {} } as AgentEvent);
      send({ type: "end", code: -1 });
    } finally {
      setActivePrompt(null);
      agentRunning = false;
      currentAbort = null;
      res.end();
    }
  });

  router.post("/agent/dom-result", authGate, (req, res) => {
    const { requestId, result } = req.body ?? {};
    if (typeof requestId !== "string" || typeof result !== "object" || result == null) {
      res.status(400).json({ error: "requestId + result required" }); return;
    }
    const ok = resolveDomInspect(requestId, result);
    res.status(ok ? 202 : 404).json({ ok });
  });

  router.post("/agent/stop", authGate, (_req, res) => {
    if (currentAbort) { currentAbort.abort(); res.status(202).json({ stopping: true }); }
    else res.status(409).json({ error: "no agent run in progress" });
  });

  router.post("/agent/permission", authGate, (req, res) => {
    const id = String(req.body?.permissionID ?? "");
    const response = req.body?.response === "approve" ? "approve" : "deny";
    const entry = pendingAsks.get(id);
    if (!entry || entry.owner !== currentUser(req)!.login) { res.status(404).json({ error: "no pending permission" }); return; }
    pendingAsks.delete(id); entry.resolve(response); res.status(202).json({ ok: true });
  });

  router.post("/agent/clone", authGate, async (req, res) => {
    if (!config.repo) { res.status(400).json({ error: "no repo configured" }); return; }
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    const repoRef = String(req.body?.repoRef ?? "");
    try {
      const sourceDir = config.repo.sourceDir ?? join(homedir(), ".tweaklet", "repos");
      const path = await doCloneRepo(repoRef, { allowlist: config.repo.allowlist ?? [], sourceDir, baseBranch: config.repo.baseBranch, token: tok.token });
      config.repo = { ...config.repo, path };
      doSaveConfig(config);
      // Live preview (P2): reflect the new clone in the dev server. Non-fatal —
      // the agent works without it; it's an enhancement.
      try { await doEnsurePreview(path, config.preview); }
      catch (e) { console.warn("Tweaklet: live-preview (re)start failed:", String(e)); }
      res.json({ path });
    } catch (e) {
      const msg = String(e);
      res.status(msg.includes("allowlist") ? 400 : 500).json({ error: msg });
    }
  });

  router.post("/agent/idea", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    try {
      const idea = String(req.body?.idea ?? "").trim();
      if (!idea) { res.status(400).json({ error: "empty idea" }); return; }
      const user = currentUser(req)!;
      const branch = await lc.startBranch(config.repo!.path!, { base: config.repo!.baseBranch, prefix: config.repo!.branchPrefix, idea });
      sessions.delete(user.login); // a new idea starts a fresh opencode session (fresh memory)
      res.json({ branch });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/agent/checkpoint", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    try {
      const message = String(req.body?.message ?? "checkpoint").trim() || "checkpoint";
      await lc.checkpoint(config.repo!.path!, message, { name: tok.name, email: tok.email });
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/agent/undo", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try { await lc.discard(config.repo!.path!); res.status(204).end(); }
    catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Reject the agent's work entirely: discard all changes and return to the base
  // branch (drops the sandbox branch). Backs the panel's "Reject changes" button.
  router.post("/agent/reject", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      await lc.reject(config.repo!.path!, {
        base: config.repo!.prTarget,
        prefix: config.repo!.branchPrefix,
      });
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/agent/refresh", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try { res.json(await lc.refresh(config.run ?? { liveUpdate: "hot-reload" }, config.repo!.path!)); }
    catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/agent/pr", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    try {
      const branch = await lc.currentBranch(config.repo!.path!);
      const user = currentUser(req)!;
      const title = String(req.body?.title ?? branch).trim() || branch;
      const body = String(req.body?.body ?? `Prototyped via tweaklet by ${user.login}.`);
      const slug = await lc.repoSlugFromRemote(config.repo!.path!);
      const apiBaseUrl = config.github?.apiBaseUrl ?? "https://api.github.com";
      const url = await lc.createDraftPr(config.repo!.path!, { branch, title, body, base: config.repo!.prTarget, owner: slug.owner, repo: slug.name, token: tok.token, apiBaseUrl });
      res.json({ url });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/agent/pr", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    try {
      const branch = await lc.currentBranch(config.repo!.path!);
      const slug = await lc.repoSlugFromRemote(config.repo!.path!);
      const apiBaseUrl = config.github?.apiBaseUrl ?? "https://api.github.com";
      res.json(await lc.prStatus(config.repo!.path!, { branch, owner: slug.owner, repo: slug.name, token: tok.token, apiBaseUrl }));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/agent/state", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      const st = await lc.branchState(config.repo!.path!, config.repo!.baseBranch);
      res.json({ ...st, previewing });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Re-hydrate the conversation after a panel reload/crash: look up the holder's
  // session id, fetch its messages from opencode, map to events. Best-effort —
  // never fail re-hydration (any fetch/mapping error → 200 with {events:[]}).
  router.get("/agent/history", authGate, async (req, res) => {
    const user = currentUser(req)!;
    const sid = sessions.get(user.login);
    if (!sid) { res.json({ events: [] }); return; }
    try {
      const client = await getClient();
      const msgs = await doFetchMessages(client, sid);
      res.json({ events: messagesToEvents(msgs), sessionId: sid });
    } catch (e) {
      res.json({ events: [], error: String(e) });
    }
  });

  router.post("/agent/preview", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const sha = String(req.body?.sha ?? "");
    if (!sha) { res.status(400).json({ error: "no sha" }); return; }
    try {
      if (await lc.isDirty(config.repo!.path!)) {
        res.status(409).json({ error: "unsaved changes", detail: "Save your current changes before previewing." });
        return;
      }
      lastBranch = (await lc.branchState(config.repo!.path!, config.repo!.baseBranch)).branch;
      await lc.previewCommit(config.repo!.path!, sha);
      previewing = sha;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/agent/preview/exit", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      await lc.exitPreview(config.repo!.path!, lastBranch ?? config.repo!.baseBranch);
      previewing = null;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/agent/restore", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    const sha = String(req.body?.sha ?? "");
    if (!sha) { res.status(400).json({ error: "no sha" }); return; }
    try {
      await lc.restoreCommit(config.repo!.path!, lastBranch ?? config.repo!.baseBranch, sha, { name: tok.name, email: tok.email });
      previewing = null;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Serve the built, self-mounting library bundle. The web Vite build (build.lib)
  // emits a single self-contained IIFE at web/dist/widget.js — React + the app +
  // CSS inlined. It derives its own base from this script's src and renders the
  // UI into a Shadow root in the host page (no iframe, no postMessage, no
  // __TWEAKLET_BASE__ HTML injection). Compiled server file lives at
  // dist/server/server.js; ../../web/dist resolves to tweaklet/web/dist.
  const widgetFile = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist/widget.js");
  router.get("/widget.js", (_req, res) => {
    if (!existsSync(widgetFile)) {
      res.status(503).type("text/plain").send("widget not built — run `npm --prefix web run build`");
      return;
    }
    res.set("Content-Type", "text/javascript; charset=utf-8").send(readFileSync(widgetFile, "utf8"));
  });

  // Bare base route → a minimal bootstrap page that just loads the widget. A dev
  // can open this URL directly to do first-run setup before embedding the
  // snippet into the host app. (No login redirect — the widget handles auth.)
  //
  // The `?standalone=1` marker tells the widget there is no host app to float
  // over, so it renders the setup UI as a centered full-page card (instead of
  // the collapsed edge launcher used when embedded). The page also carries a
  // neutral backdrop so it looks intentional before the widget paints.
  function bootstrapHtml(): string {
    return (
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Tweaklet setup</title>` +
      `<style>html,body{margin:0;height:100%;background:#f1efe9}</style>` +
      `</head><body><script src="${basePath}/widget.js?standalone=1"></script></body></html>`
    );
  }
  router.get("/", (_req, res) => { res.type("html").send(bootstrapHtml()); });

  // ── DOM-inspect MCP endpoint ──────────────────────────────────────────────
  // Exposes the `dom_query` MCP tool over Streamable HTTP at `${basePath}/mcp`.
  // opencode runs on the same host and connects over loopback, so we hard-gate
  // this to loopback callers — there is no auth on the MCP transport itself and
  // it must never be reachable from the network. Mounted before the catch-all.
  router.use("/mcp", (req, res, next) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: "mcp endpoint is loopback-only" });
      return;
    }
    next();
  });
  mountDomMcp(router, "/mcp");

  // Mount all tweaklet routes under the configured basePath
  app.use(basePath, router);

  // Health check at root (outside router) — useful for infra probes
  app.get("/", (_req, res) => { res.status(200).send("ok"); });

  return app;
}

/**
 * Start the tweaklet server and print the setup token (when applicable).
 * This is the production entry point — `createServer` is the testable unit.
 */
export function serve(config: TweakletConfig): void {
  // Generate the setup token before creating the server so we can print it.
  const setupToken = config.setup.completed
    ? undefined
    : randomBytes(24).toString("base64url");

  // Ensure opencode's provider config exists for the configured model before we
  // warm up opencode — so the model resolves on a from-scratch box.
  if (config.agent) { try { ensureOpencodeProvider(config.agent, { port: config.server.port, basePath: config.server.basePath }); } catch (e) { console.warn("Tweaklet: could not write opencode provider config:", String(e)); } }

  createServer(config, { setupToken }).listen(config.server.port, () => {
    console.log(`Tweaklet listening on ${config.server.publicUrl}`);
    if (setupToken) {
      console.log(
        `\nTweaklet setup token: ${setupToken}\n` +
        `  (enter it in the setup wizard to configure this server)\n`,
      );
    }
    getServer(config.repo?.path)
      .then(() => console.log("Tweaklet: opencode server ready"))
      .catch((e) => console.warn("Tweaklet: opencode server warm-up failed (will retry on first prompt):", String(e)));
  });

  // Graceful shutdown: close the opencode child so it dies WITH the service.
  // opencode binds a fixed port (4096); a child orphaned on restart blocks the
  // next instance from binding it ("ServeError"). Closing on SIGTERM/SIGINT
  // (systemctl restart sends SIGTERM) prevents the orphan.
  let _shuttingDown = false;
  const shutdown = (sig: string) => {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`Tweaklet: ${sig} — closing opencode server`);
    void stopServer().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
