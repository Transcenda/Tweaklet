import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { TweakletConfig, TweakletConfigInput } from "../config/config.js";
import {
  ConfigSchema,
  loadConfig as realLoadConfig,
  saveConfig as realSaveConfig,
  configPath,
} from "../config/config.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken as realExchange,
  fetchGithubUser as realFetchUser,
  type GithubUser,
} from "../auth/github-oauth.js";
import { ghCliUser as realGhCliUser } from "../auth/gh-cli.js";
import { hasPushAccess as realHasPushAccess } from "../auth/repo-access.js";
import { sign, verify } from "../auth/signing.js";
import type { AgentEvent } from "../agent/events.js";
import { fetchSessionMessages as realFetchSessionMessages, messagesToEvents } from "../agent/history.js";
import { runPrompt as realRunPrompt, getServer, stopServer, smokeTestAgent as realSmokeTestAgent } from "../agent/opencode-server.js";
import { ensureOpencodeProvider } from "../agent/provider-config.js";
import { mountDomMcp } from "../agent/mcp-server.js";
import { isValidMcpAuth } from "../agent/mcp-secret.js";
import { DEFAULT_SAFE_COMMANDS } from "../agent/decide.js";
import { makeSessionStore } from "./session-store.js";
import type { SessionStore } from "./session-store.js";
import { setActivePrompt, resolveDomInspect, type DomResult } from "../agent/dom-inspect.js";
import * as repoLib from "../git/repo.js";
import { redactUrlCredentials } from "../git/validate.js";
import { gitHostFromApiBase } from "../git/token-git.js";
import { matchesAllow } from "../guardrails/guardrails.js";
import * as prLib from "../git/pr.js";
import { refresh as realRefresh } from "../run/live-update.js";
import { runDiagnostics as realRunDiagnostics } from "../doctor/doctor.js";
import { cloneAllowedRepo, parseRepoRef } from "../repo/clone.js";
import { ensurePreview as realEnsurePreview } from "../run/preview.js";
import { computeSetupState } from "./setup-state.js";

export interface ServerDeps {
  exchangeCodeForToken?: typeof realExchange;
  fetchGithubUser?: typeof realFetchUser;
  /** Does a GitHub user have write access to a repo? Injected in tests. */
  checkRepoAccess?: typeof realHasPushAccess;
  ghCliUser?: typeof realGhCliUser;
  runPrompt?: typeof realRunPrompt;
  getClient?: () => Promise<any>;
  /** Injectable agent smoke-test (real prompt round-trip) for verify-agent; stubbed in tests. */
  smokeTestAgent?: typeof realSmokeTestAgent;
  lifecycle?: {
    startBranch: typeof repoLib.startBranch;
    syncIntoBranch: typeof repoLib.syncIntoBranch;
    currentBranch: typeof repoLib.currentBranch;
    checkpoint: typeof repoLib.checkpoint;
    discard: typeof repoLib.discard;
    reject: typeof repoLib.reject;
    branchState: typeof repoLib.branchState;
    isDirty: typeof repoLib.isDirty;
    previewCommit: typeof repoLib.previewCommit;
    exitPreview: typeof repoLib.exitPreview;
    restoreCommit: typeof repoLib.restoreCommit;
    listBranches: typeof repoLib.listBranches;
    switchBranch: typeof repoLib.switchBranch;
    deleteBranch: typeof repoLib.deleteBranch;
    changedFiles: typeof repoLib.changedFiles;
    branchOwner: typeof repoLib.branchOwner;
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
  /** Upper bound for /agent/history, so a stuck opencode can't hang the panel. */
  historyTimeoutMs?: number;
  /** How long a permission ask waits for an answer before it's denied. Injected in tests. */
  askTimeoutMs?: number;
  /** Clock for the active-user idle timeout. Injected in tests. */
  now?: () => number;
  /** Requests per minute: `api` per signed-in user (or client), `auth` per client. Tests lower these. */
  rateLimit?: { api?: number; auth?: number };
}

const SESSION_COOKIE = "apz_session";
const STATE_COOKIE = "apz_oauth_state";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** What a session cookie carries. `typ` keeps other signed values (like the
 *  OAuth state cookie) from ever passing as a session; `sid` lets logout
 *  revoke it server-side; `exp` bounds its life. */
interface SessionClaims {
  typ: "session";
  sid: string;
  login: string;
  id: number;
  name?: string;
  email?: string;
  iat: number;
  exp: number;
}

/** Mint a signed session token for a GitHub user. Exported for tests. */
export function issueSessionToken(
  user: { login: string; id: number; name?: string; email?: string },
  secret: string,
  now = Date.now(),
): string {
  const claims: SessionClaims = {
    typ: "session", sid: randomBytes(16).toString("hex"),
    login: user.login, id: user.id, name: user.name, email: user.email,
    iat: now, exp: now + SESSION_TTL_MS,
  };
  return sign(claims, secret);
}

function parseSession(token: string, secret: string, now = Date.now()): SessionClaims | null {
  const c = verify<Partial<SessionClaims>>(token, secret);
  if (!c || c.typ !== "session") return null;
  if (typeof c.sid !== "string" || typeof c.login !== "string" || typeof c.id !== "number") return null;
  if (typeof c.exp !== "number" || c.exp <= now) return null;
  return c as SessionClaims;
}

/** An error for a client: never echo credentials embedded in remote URLs. */
function errorText(e: unknown): string {
  return redactUrlCredentials(String(e));
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

/** A change title from a prompt: the panel prepends picked-element context
 *  blocks separated by a blank line, so use the first line of the user's own
 *  text (the last block). */
export function titleFromPrompt(prompt: string): string {
  const own = prompt.split(/\n\s*\n/).filter((b) => b.trim()).pop() ?? prompt;
  const line = own.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.slice(0, 80) || "New change";
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "via"];

/**
 * True only for a request made directly on this machine — never one relayed by
 * a reverse proxy. Behind a same-host proxy every request arrives on a loopback
 * socket, so the socket alone proves nothing: also require that no proxy header
 * is present and that the request is addressed to a local hostname (a proxy
 * that adds no headers still forwards the public Host, or its own upstream).
 */
export function isDirectLocal(req: { socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }): boolean {
  const addr = req.socket?.remoteAddress;
  if (!addr || !LOOPBACK_ADDRS.has(addr)) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const host = String(req.headers.host ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTNAMES.has(hostname);
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    // First wins: browsers send the most specific path first, so a current
    // /tweaklet-scoped cookie beats a leftover root-scoped one.
    if (name in out) continue;
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed — skip */ }
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
  const tokenStore = new Map<string, { token: string; name: string; email: string; accessCheckedAt?: number }>();
  function currentToken(req: Request): { token: string; name: string; email: string } | null {
    const u = currentUser(req);
    return u ? tokenStore.get(u.login) ?? null : null;
  }
  const pendingAsks = new Map<string, { owner: string; resolve: (r: "approve" | "deny") => void }>();
  let agentRunning = false;
  let runOwner: string | null = null; // whose agent turn is streaming
  let currentAbort: AbortController | null = null;
  let previewing: string | null = null;
  let lastBranch: string | null = null;
  const lc = deps.lifecycle ?? {
    startBranch: repoLib.startBranch,
    syncIntoBranch: repoLib.syncIntoBranch,
    currentBranch: repoLib.currentBranch,
    checkpoint: repoLib.checkpoint,
    discard: repoLib.discard,
    reject: repoLib.reject,
    branchState: repoLib.branchState,
    isDirty: repoLib.isDirty,
    previewCommit: repoLib.previewCommit,
    exitPreview: repoLib.exitPreview,
    restoreCommit: repoLib.restoreCommit,
    listBranches: repoLib.listBranches,
    switchBranch: repoLib.switchBranch,
    deleteBranch: repoLib.deleteBranch,
    changedFiles: repoLib.changedFiles,
    branchOwner: repoLib.branchOwner,
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
  const branchOpts = () => ({ base: config.repo!.baseBranch, prefix: config.repo!.branchPrefix });
  /** The git host the user's token belongs to (github.com, or a GitHub Enterprise host). */
  const gitHost = () => gitHostFromApiBase(config.github?.apiBaseUrl ?? "https://api.github.com");
  /** Who auto-saves are attributed to: the GitHub identity when we hold one. */
  function authorFor(req: Request): repoLib.CommitAuthor {
    const t = currentToken(req);
    if (t) return { name: t.name, email: t.email };
    const u = currentUser(req)!;
    return { name: u.login, email: `${u.login}@users.noreply.github.com` };
  }
  /** opencode sessions are per user AND per change, so switching a change
   *  restores its conversation and a new change starts with fresh memory. */
  const keyFor = (login: string, branch: string) => `${login}@${branch}`;
  async function sessionKey(login: string): Promise<string> {
    if (!config.repo?.path) return login;
    try { return keyFor(login, await lc.currentBranch(config.repo.path)); } catch { return login; }
  }
  /** Who decides risky agent actions. A server with GitHub sign-in is shared,
   *  so the server decides (`auto`); a developer's own machine asks the person. */
  function approvalMode(): "auto" | "ask" {
    return config.agent?.approvals ?? (config.github?.clientId ? "auto" : "ask");
  }
  /** Keep the live preview in step with the clone (deps + unit). Non-fatal. */
  async function syncPreview(): Promise<void> {
    if (!config.repo?.path) return;
    try { await doEnsurePreview(config.repo.path, config.preview); }
    catch (e) { console.warn("Tweaklet: live-preview refresh failed:", String(e)); }
  }
  // ── One writer at a time on the shared clone ─────────────────────────────
  // Every route that moves HEAD or rewrites the working tree takes this lock
  // for its whole duration (released when the response finishes), and refuses
  // while an agent turn is editing files. Prompts refuse while it's held.
  let treeBusy = false;
  const TREE_ROUTES = [
    "/agent/idea", "/agent/sync", "/agent/checkpoint", "/agent/undo", "/agent/reject",
    "/agent/preview", "/agent/preview/exit", "/agent/restore",
    "/agent/branches/switch", "/agent/branches/delete",
  ];
  function treeLock(_req: Request, res: Response, next: NextFunction): void {
    if (agentRunning) { res.status(409).json({ error: "the agent is still working — stop it first" }); return; }
    if (treeBusy) { res.status(409).json({ error: "another change operation is still running — try again in a moment" }); return; }
    treeBusy = true;
    let released = false;
    const release = () => { if (!released) { released = true; treeBusy = false; } };
    res.on("finish", release);
    res.on("close", release);
    next();
  }
  const secret = config.server.sessionSecret;
  const basePath = config.server.basePath ?? "/tweaklet";
  const redirectUri = `${config.server.publicUrl}${basePath}/auth/callback`;
  const app = express();
  // Tweaklet runs behind a reverse proxy on the same machine: trust forwarding
  // headers from loopback only, so req.ip is the real client (rate limiting)
  // while a remote caller can't spoof one.
  app.set("trust proxy", "loopback");
  app.use(express.json());

  // ── Who may use Tweaklet: people with write access on GitHub ───────────────
  // Access follows the repository: anyone who can push to it (directly, via a
  // team, or as an org admin) may sign in; remove them on GitHub and they lose
  // Tweaklet too (re-checked every ACCESS_RECHECK_MS while they hold it).
  // access.allowedLogins / allowedUserIds, when set, narrow this further.
  const doCheckRepoAccess = deps.checkRepoAccess ?? realHasPushAccess;
  const ACCESS_RECHECK_MS = 10 * 60_000;
  let clonedSlug: { owner: string; name: string } | null = null;
  async function accessRepos(): Promise<{ owner: string; name: string }[]> {
    if (config.repo?.path) {
      if (!clonedSlug) {
        try { clonedSlug = await lc.repoSlugFromRemote(config.repo.path); } catch { clonedSlug = null; }
      }
      if (clonedSlug) return [clonedSlug];
    }
    return (config.repo?.allowlist ?? []).map((r) => parseRepoRef(r)).filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ owner: r.owner, name: r.name }));
  }
  const hasExplicitAllowlist = () => !!(config.access?.allowedLogins?.length || config.access?.allowedUserIds?.length);
  /** May this GitHub user use Tweaklet? `null` = yes, otherwise the reason. */
  async function accessDenied(user: GithubUser, token: string): Promise<string | null> {
    if (!isAllowed(user, config)) return `@${user.login} isn't on this server's access list.`;
    const repos = await accessRepos();
    if (repos.length === 0) {
      return hasExplicitAllowlist() ? null : "No repository is configured yet, so nobody can sign in. Ask your admin to finish setup.";
    }
    const apiBaseUrl = config.github?.apiBaseUrl ?? "https://api.github.com";
    for (const r of repos) {
      if (await doCheckRepoAccess({ token, owner: r.owner, name: r.name, apiBaseUrl })) return null;
    }
    const names = repos.map((r) => `${r.owner}/${r.name}`).join(", ");
    return `@${user.login} doesn't have write access to ${names} on GitHub, so can't use Tweaklet here.`;
  }
  /** Re-check the holder's GitHub access in the background; drop them if it's gone. */
  function recheckAccess(login: string) {
    const t = tokenStore.get(login);
    if (!t || now() - (t.accessCheckedAt ?? 0) < ACCESS_RECHECK_MS) return;
    t.accessCheckedAt = now();
    void accessDenied({ login, id: -1, name: t.name, email: t.email }, t.token).then((reason) => {
      if (reason && holder && sameLogin(holder.login, login)) releaseHolder();
    });
  }

  // ── One active user at a time ("booking") ──────────────────────────────────
  // Whoever signs in holds the server: every action runs under their GitHub
  // identity, so nobody else can sign in until they sign out or go idle. On
  // release their GitHub token is erased and their session stops counting.
  const now = deps.now ?? Date.now;
  const idleMs = (config.session?.idleMinutes ?? 30) * 60_000;
  let holder: { login: string; lastSeen: number } | null = null;
  // Sessions issued before the last release (sign-out / idle) can't re-take the
  // hold by themselves; after a server restart (nothing released yet) the first
  // valid session to come back takes it.
  let lastReleaseAt = 0;
  const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  function releaseHolder() {
    if (holder) tokenStore.delete(holder.login);
    holder = null;
    lastReleaseAt = now();
  }
  /** The current holder, after releasing one who has been idle too long. */
  function activeHolder() {
    if (holder && !agentRunning && now() - holder.lastSeen > idleMs) releaseHolder();
    return holder;
  }
  /** Take (or refresh) the hold for `login`; false if someone else holds it. */
  function claimHold(login: string): boolean {
    const h = activeHolder();
    if (h && !sameLogin(h.login, login)) return false;
    holder = { login, lastSeen: now() };
    return true;
  }
  function holdBusyMinutes(): number {
    return holder ? Math.max(0, Math.ceil((holder.lastSeen + idleMs - now()) / 60_000)) : 0;
  }

  // Sessions revoked by logout (sid → expiry), pruned as they expire.
  const revokedSessions = new Map<string, number>();
  function revoke(claims: SessionClaims) {
    const t = now();
    for (const [sid, exp] of revokedSessions) if (exp <= t) revokedSessions.delete(sid);
    revokedSessions.set(claims.sid, claims.exp);
  }
  function sessionClaims(req: Request): SessionClaims | null {
    const tok = parseCookies(req)[SESSION_COOKIE];
    const c = tok ? parseSession(tok, secret, now()) : null;
    return c && !revokedSessions.has(c.sid) ? c : null;
  }
  /** The signed-in user — only for a valid, unexpired, unrevoked session of
   *  someone who is (still) allowed in AND currently holds the server. A
   *  session issued before an idle release no longer counts: sign in again. */
  function currentUser(req: Request): GithubUser | null {
    const c = sessionClaims(req);
    if (!c) return null;
    const user: GithubUser = { login: c.login, id: c.id, name: c.name ?? c.login, email: c.email ?? "" };
    if (!isAllowed(user, config)) return null;
    const h = activeHolder();
    if (h) {
      if (!sameLogin(h.login, user.login)) return null;
      h.lastSeen = now();
      recheckAccess(user.login);
      return user;
    }
    if (c.iat <= lastReleaseAt) return null;
    return claimHold(user.login) ? user : null;
  }
  /** The page the sign-in popup lands on: tells the opener (same origin only)
   *  how sign-in went, then closes; falls back to text/redirect if opened directly. */
  function signInResultPage(res: Response, status: number, ok: boolean, message = "") {
    const payload = JSON.stringify(ok ? { type: "tweaklet:signed-in" } : { type: "tweaklet:sign-in-failed", message })
      .replace(/</g, "\\u003c");
    const text = (ok ? "Signed in — you may close this window." : message).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    res.status(status).type("html").send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Tweaklet — ${ok ? "signed in" : "sign-in"}</title></head><body>` +
      `<script>` +
      `if(window.opener){window.opener.postMessage(${payload},window.location.origin);window.close();}` +
      (ok ? `else{window.location.replace(${JSON.stringify(basePath + "/")});}` : ``) +
      `</script><p>${text}</p></body></html>`,
    );
  }
  function busyMessage(): string {
    const mins = holdBusyMinutes();
    return `Tweaklet is in use by @${holder!.login} right now. It frees up when they sign out, or after ${config.session?.idleMinutes ?? 30} minutes of inactivity (about ${mins} min from now).`;
  }

  const secureCookies = config.server.publicUrl.startsWith("https://");
  function setSession(res: Response, user: GithubUser) {
    res.cookie(SESSION_COOKIE, issueSessionToken(user, secret, now()), {
      httpOnly: true, secure: secureCookies, sameSite: "lax", path: basePath, maxAge: SESSION_TTL_MS,
    });
    res.clearCookie(SESSION_COOKIE, { path: "/" }); // legacy root-scoped cookie from older versions
  }

  function authGate(req: Request, res: Response, next: NextFunction) {
    if (currentUser(req)) return next();
    res.status(401).json({ error: "unauthorized" });
  }

  // Create a router for all tweaklet routes mounted under basePath
  const router = express.Router();

  // ── Cross-site request protection ─────────────────────────────────────────
  // The session cookie is SameSite=Lax, which still lets a sibling subdomain
  // (or an old browser) POST to us. Every state-changing request must come
  // from our own origin: browsers say so in Sec-Fetch-Site; for older ones we
  // check Origin. Clients that send neither (CLI, tests) aren't browsers, so
  // there's no ambient cookie to abuse. /mcp is excluded — it needs its token.
  const publicOrigin = new URL(config.server.publicUrl).origin;
  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || req.path.startsWith("/mcp")) return next();
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    const ownOrigin = origin && (origin === publicOrigin || origin === `${req.protocol}://${req.headers.host}`);
    if ((site && site !== "same-origin" && site !== "none") || (origin && !ownOrigin)) {
      res.status(403).json({ error: "cross-site request refused" });
      return;
    }
    next();
  });

  // ── Rate limiting ───────────────────────────────────────────────────────────
  // Registered before every route. API calls are counted per signed-in user,
  // because behind a reverse proxy every request arrives from 127.0.0.1, and
  // keying by IP would make all users share one budget. Anonymous calls fall
  // back to the client address. Sign-in routes get a tighter per-client limit.
  // The widget bundle and bootstrap page are never limited (every page view of
  // the host app loads them).
  const limitMessage = { error: "too many requests — slow down and try again in a minute" };
  const clientKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "")}`;
  const limiterBase = { windowMs: 60_000, standardHeaders: "draft-8" as const, legacyHeaders: false, message: limitMessage };
  router.use(["/agent", "/setup"], rateLimit({
    ...limiterBase,
    limit: deps.rateLimit?.api ?? 600,
    keyGenerator: (req) => {
      const u = currentUser(req as Request);
      return u ? `user:${u.login.toLowerCase()}` : clientKey(req as Request);
    },
  }));
  router.use("/auth", rateLimit({ ...limiterBase, limit: deps.rateLimit?.auth ?? 30, keyGenerator: (req) => clientKey(req as Request) }));

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
      // Unreadable config: only treat it as "setup not done yet" if this
      // server also started unconfigured — never reopen a finished setup.
      if (config.setup.completed) {
        res.status(410).json({ error: "setup already completed" });
        return;
      }
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
      // Setup was already complete when this server started: there is no
      // token, so nothing may pass (fail closed, even if the config changes).
      res.status(410).json({ error: "setup already completed" });
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
    // Signing in as this machine's `gh` user is a convenience for a developer's
    // own laptop. A server with GitHub sign-in configured never needs it, and it
    // must never be reachable through a proxy.
    if (config.github?.clientId) {
      res.redirect(`${basePath}/auth/login`);
      return;
    }
    if (!isDirectLocal(req)) {
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
    if (!claimHold(user.login)) { signInResultPage(res, 423, false, busyMessage()); return; }
    setSession(res, user);
    res.redirect(`${basePath}/`);
  });

  // For the sign-in screen: is someone else using this server? Deliberately
  // anonymous — it never says who.
  router.get("/auth/status", (_req, res) => {
    const h = activeHolder();
    res.json({ inUse: !!h, idleMinutes: config.session?.idleMinutes ?? 30, ...(h ? { freeInMinutes: holdBusyMinutes() } : {}) });
  });

  router.get("/auth/login", (_req, res) => {
    if (!config.github) {
      res.status(400).json({ error: "GitHub OAuth is not configured yet — complete the 'GitHub OAuth' step in setup (paste your OAuth App's Client ID + Secret) before signing in." });
      return;
    }
    const state = randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, sign({ typ: "oauth-state", state, exp: Date.now() + OAUTH_STATE_TTL_MS }, secret), {
      httpOnly: true, secure: secureCookies, sameSite: "lax", path: basePath, maxAge: OAUTH_STATE_TTL_MS,
    });
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
    const expected = signed ? verify<{ typ?: string; state?: string; exp?: number }>(signed, secret) : null;
    const stateOk = !!expected && expected.typ === "oauth-state" && typeof expected.exp === "number"
      && expected.exp > Date.now() && typeof expected.state === "string" && expected.state === state;
    if (!code || !stateOk) {
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
      const denied = await accessDenied(user, token);
      if (denied) {
        res.clearCookie(STATE_COOKIE, { path: basePath });
        signInResultPage(res, 403, false, denied);
        return;
      }
      if (!claimHold(user.login)) {
        res.clearCookie(STATE_COOKIE, { path: basePath });
        signInResultPage(res, 423, false, busyMessage());
        return;
      }
      tokenStore.set(user.login, { token, name: user.name, email: user.email, accessCheckedAt: now() });
      setSession(res, user);
      res.clearCookie(STATE_COOKIE, { path: basePath });
      signInResultPage(res, 200, true);
    } catch (e) {
      res.status(502).json({ error: "oauth failed", detail: errorText(e) });
    }
  });

  router.post("/auth/logout", (req, res) => {
    const c = sessionClaims(req);
    if (c) {
      revoke(c);
      tokenStore.delete(c.login);
      if (holder && sameLogin(holder.login, c.login)) releaseHolder();
    }
    res.clearCookie(SESSION_COOKIE, { path: basePath });
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  router.post(TREE_ROUTES, authGate, treeLock);

  router.get("/agent/me", authGate, (req, res) => {
    // needsReauth: OAuth is configured but this server no longer holds the
    // user's token (tokens are memory-only, so any restart drops them). Without
    // it we can't fetch the latest base or submit — the panel nudges a reconnect.
    const needsReauth = !!config.github?.clientId && !currentToken(req);
    res.json({ ...currentUser(req), needsReauth });
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
    if (treeBusy) {
      res.status(409).json({ error: "another change operation is still running — try again in a moment" });
      return;
    }
    if (previewing) {
      // A detached preview isn't a change: edits made there would be lost.
      res.status(409).json({ error: "you're previewing an earlier save — restore it or go back to the latest first" });
      return;
    }
    const user = currentUser(req)!;
    agentRunning = true;
    runOwner = user.login;
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
    // Closing the tab (or losing the connection) stops the run, rather than
    // leaving an unsupervised agent working and the change locked.
    const abortOnClose = currentAbort;
    res.on("close", () => { if (!res.writableEnded) abortOnClose.abort(); });
    // An unanswered ask (person walked away) is denied after ASK_TIMEOUT_MS
    // instead of holding the agent — and the server — forever.
    const onAsk = (r: { permissionID: string; permission: string; patterns: string[]; diff?: string }) =>
      new Promise<"approve" | "deny">((resolve) => {
        const timer = setTimeout(() => {
          if (pendingAsks.delete(r.permissionID)) resolve("deny");
        }, deps.askTimeoutMs ?? ASK_TIMEOUT_MS);
        timer.unref?.();
        pendingAsks.set(r.permissionID, { owner: user.login, resolve: (v) => { clearTimeout(timer); resolve(v); } });
        send({ type: "permission_ask", permissionID: r.permissionID, permission: r.permission, patterns: r.patterns, diff: r.diff } as any);
      });
    try {
      // A prompt never runs on the base branch: start a fresh change (cut from
      // the latest base) first, so every edit is isolated and reviewable.
      if (config.repo?.path && (await lc.currentBranch(config.repo.path)) === config.repo.baseBranch) {
        const started = await lc.startBranch(config.repo.path, { ...branchOpts(), idea: titleFromPrompt(prompt), token: currentToken(req)?.token ?? "", author: authorFor(req), owner: user.login, gitHost: gitHost() });
        sessions.delete(keyFor(user.login, started.branch));
        previewing = null;
        send({ type: "branch", ...started } as any);
        await syncPreview();
      }
      const key = await sessionKey(user.login);
      const client = await getClient();
      const { sessionId, blocked } = await doRun({
        client,
        sessionId: sessions.get(key),
        model: config.agent!.model!,
        prompt,
        allow: config.guardrails.allow,
        repoRoot: config.repo?.path || undefined,
        mode: approvalMode(),
        safeCommands: config.agent?.safeCommands ?? DEFAULT_SAFE_COMMANDS,
        onEvent: send,
        onAsk,
        signal: currentAbort.signal,
      });
      sessions.set(key, sessionId);
      if (blocked.length) send({ type: "guardrail", blocked, raw: {} } as any);
      send({ type: "end", code: 0 });
    } catch (e) {
      send({ type: "error", message: String(e), raw: {} } as AgentEvent);
      send({ type: "end", code: -1 });
    } finally {
      setActivePrompt(null);
      agentRunning = false;
      runOwner = null;
      if (holder) holder.lastSeen = now(); // a long agent turn counts as activity
      currentAbort = null;
      res.end();
    }
  });

  router.post("/agent/dom-result", authGate, (req, res) => {
    // Only the person whose agent turn asked may answer, and only with a
    // bounded page snapshot.
    if (!runOwner || !sameLogin(runOwner, currentUser(req)!.login)) {
      res.status(404).json({ ok: false }); return;
    }
    if (JSON.stringify(req.body ?? {}).length > 32_768) {
      res.status(413).json({ error: "page snapshot too large" }); return;
    }
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
      res.status(msg.includes("allowlist") ? 400 : 500).json({ error: redactUrlCredentials(msg) });
    }
  });

  router.post("/agent/idea", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    try {
      const idea = String(req.body?.idea ?? "").trim();
      if (!idea) { res.status(400).json({ error: "empty idea" }); return; }
      const user = currentUser(req)!;
      // Pass the user's token IF we have one, so startBranch can refresh the base
      // from origin (authenticated) before cutting the new branch — avoids
      // stale-base drift. Without a token (local/CLI auth, no OAuth) syncBase is a
      // best-effort no-op and the change starts from the local base, so starting a
      // change must NOT require a token (only clone/PR, which truly hit GitHub, do).
      const tok = currentToken(req);
      const started = await lc.startBranch(config.repo!.path!, { ...branchOpts(), idea, token: tok?.token ?? "", author: authorFor(req), owner: user.login, gitHost: gitHost() });
      sessions.delete(keyFor(user.login, started.branch)); // a new change starts with fresh memory
      previewing = null; lastBranch = null;
      await syncPreview();
      res.json(started);
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  // On-demand "sync with base": merge the latest origin/<base> INTO the current
  // feature branch. Conflict-safe — see syncIntoBranch (dirty/up-to-date/updated/
  // conflict; never leaves a conflicted tree, never auto-resolves).
  router.post("/agent/sync", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    try {
      const result = await lc.syncIntoBranch(config.repo!.path!, config.repo!.baseBranch, tok.token, gitHost());
      res.json(result);
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  router.post("/agent/checkpoint", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    try {
      const message = String(req.body?.message ?? "checkpoint").trim() || "checkpoint";
      if ((await lc.currentBranch(config.repo!.path!)) === config.repo!.baseBranch) {
        res.status(409).json({ error: "start a change first — saves never go on the base branch" });
        return;
      }
      await lc.checkpoint(config.repo!.path!, message, { name: tok.name, email: tok.email });
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  router.post("/agent/undo", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try { await lc.discard(config.repo!.path!); res.status(204).end(); }
    catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  // Reject the agent's work entirely: discard all changes and return to the base
  // branch (drops the sandbox branch). Backs the panel's "Reject changes" button.
  router.post("/agent/reject", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    try {
      // Discarding deletes the change for good — same rule as delete: only
      // whoever started it (changes from before owners were recorded stay open).
      const login = currentUser(req)!.login;
      const branch = await lc.currentBranch(config.repo!.path!);
      const owner = branch !== config.repo!.baseBranch ? await lc.branchOwner(config.repo!.path!, branch) : null;
      if (owner && !sameLogin(owner, login)) {
        res.status(403).json({ error: `only @${owner} can discard this change` });
        return;
      }
      sessions.delete(await sessionKey(login));
      await lc.reject(config.repo!.path!, {
        base: config.repo!.prTarget,
        prefix: config.repo!.branchPrefix,
      });
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  router.post("/agent/refresh", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try { res.json(await lc.refresh(config.run ?? { liveUpdate: "hot-reload" }, config.repo!.path!)); }
    catch (e) { res.status(500).json({ error: errorText(e) }); }
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
      // A PR may only carry what the guardrails let the agent edit — never a CI
      // workflow, build script or anything else an approved command wrote.
      const outside = (await lc.changedFiles(config.repo!.path!, config.repo!.baseBranch))
        .filter((f) => !matchesAllow(f, config.guardrails.allow));
      if (outside.length) {
        res.status(409).json({ error: "this change touches files outside the editable area, so it can't be submitted", files: outside.slice(0, 50) });
        return;
      }
      const url = await lc.createDraftPr(config.repo!.path!, { branch, title, body, base: config.repo!.prTarget, owner: slug.owner, repo: slug.name, token: tok.token, apiBaseUrl });
      res.json({ url });
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
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
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  router.get("/agent/state", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      const st = await lc.branchState(config.repo!.path!, config.repo!.baseBranch);
      res.json({ ...st, previewing });
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  // ── Change workspace: list / switch / delete Tweaklet branches ─────────────
  router.get("/agent/branches", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      const path = config.repo!.path!;
      res.json({ base: config.repo!.baseBranch, current: await lc.currentBranch(path), branches: await lc.listBranches(path, branchOpts()) });
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  router.post("/agent/branches/switch", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const branch = String(req.body?.branch ?? "");
    if (!branch) { res.status(400).json({ error: "no branch" }); return; }
    try {
      await lc.switchBranch(config.repo!.path!, branch, { ...branchOpts(), author: authorFor(req) });
      previewing = null; lastBranch = null;
      await syncPreview();
      res.json({ branch });
    } catch (e) {
      const msg = String(e);
      res.status(/not a Tweaklet change|no such change|invalid branch/.test(msg) ? 400 : 500).json({ error: redactUrlCredentials(msg) });
    }
  });

  router.post("/agent/branches/delete", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const branch = String(req.body?.branch ?? "");
    if (!branch) { res.status(400).json({ error: "no branch" }); return; }
    try {
      // Deleting is permanent and local-only: only whoever started the change
      // may delete it (changes from before owners were recorded stay open).
      const login = currentUser(req)!.login;
      const owner = await lc.branchOwner(config.repo!.path!, branch);
      if (owner && owner.toLowerCase() !== login.toLowerCase()) {
        res.status(403).json({ error: `only @${owner} can delete this change` });
        return;
      }
      await lc.deleteBranch(config.repo!.path!, branch, branchOpts());
      sessions.delete(keyFor(login, branch));
      previewing = null; lastBranch = null;
      await syncPreview();
      res.status(204).end();
    } catch (e) {
      const msg = String(e);
      res.status(/not a Tweaklet change|no such change|invalid branch/.test(msg) ? 400 : 500).json({ error: redactUrlCredentials(msg) });
    }
  });

  // Re-hydrate the conversation after a panel reload/crash: look up the holder's
  // session id, fetch its messages from opencode, map to events. Best-effort —
  // never fail re-hydration (any fetch/mapping error → 200 with {events:[]}).
  router.get("/agent/history", authGate, async (req, res) => {
    const user = currentUser(req)!;
    const sid = sessions.get(await sessionKey(user.login));
    if (!sid) { res.json({ events: [] }); return; }
    try {
      const msgs = await Promise.race([
        getClient().then((client) => doFetchMessages(client, sid)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("history timed out — the agent isn't responding")), deps.historyTimeoutMs ?? 8000).unref?.()),
      ]);
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
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  router.post("/agent/preview/exit", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      await lc.exitPreview(config.repo!.path!, lastBranch ?? config.repo!.baseBranch);
      previewing = null;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
  });

  router.post("/agent/restore", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const tok = currentToken(req);
    if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
    const sha = String(req.body?.sha ?? "");
    if (!sha) { res.status(400).json({ error: "no sha" }); return; }
    // Restore is the second half of preview: only the save being previewed,
    // onto the change it came from — never onto the base.
    if (!previewing || !lastBranch || sha !== previewing) {
      res.status(409).json({ error: "preview the save you want to restore first" });
      return;
    }
    try {
      await lc.restoreCommit(config.repo!.path!, lastBranch, sha, { name: tok.name, email: tok.email });
      previewing = null;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: errorText(e) }); }
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
    if (!isDirectLocal(req) || !isValidMcpAuth(req.headers.authorization)) {
      res.status(403).json({ error: "mcp endpoint is local-only and requires this server's token" });
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

  // Bound to loopback by default: the reverse proxy on this machine is the only
  // way in. Set server.host (e.g. "0.0.0.0") to expose it directly.
  createServer(config, { setupToken }).listen(config.server.port, config.server.host ?? "127.0.0.1", () => {
    console.log(`Tweaklet listening on ${config.server.publicUrl}`);
    if (setupToken) {
      // Kept out of the log (journals are often readable by other users): it
      // goes to a 0600 file next to the config, and only the path is printed.
      const tokenFile = join(dirname(configPath()), "setup-token");
      try {
        mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
        writeFileSync(tokenFile, setupToken + "\n", { mode: 0o600 });
        chmodSync(tokenFile, 0o600);
        console.log(`\nTweaklet isn't set up yet. Your one-time setup token is in ${tokenFile}\n  (read it with: cat ${tokenFile} — then enter it in the setup wizard)\n`);
      } catch (e) {
        console.warn("Tweaklet: could not write the setup token file:", String(e));
      }
    }
    // Self-heal the live preview on start (e.g. after a VM reboot left the dev
    // server stopped, or the clone's deps drifted). Non-fatal.
    if (config.repo?.path && config.preview) {
      realEnsurePreview(config.repo.path, config.preview)
        .then((r) => console.log(`Tweaklet: live preview ready (installed=${r.installed}, restarted=${r.restarted})`))
        .catch((e) => console.warn("Tweaklet: live-preview start failed:", String(e)));
    }
    getServer(config.repo?.path)
      .then(() => console.log("Tweaklet: opencode server ready"))
      .catch((e) => console.warn("Tweaklet: opencode server warm-up failed (will retry on first prompt):", String(e)));
  });

  // Graceful shutdown: close the opencode child so it dies WITH the service.
  // opencode prefers port 4096 (falling back to a free one); a child orphaned on restart can block the
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
