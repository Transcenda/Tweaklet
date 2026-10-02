import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { authGit } from "../git/token-git.js";
import { redactUrlCredentials } from "../git/validate.js";

/** exec abstraction — injected for tests, defaults to pexec. */
type Exec = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout?: string | Buffer } | undefined>;

const pexec: Exec = (cmd, args, env) =>
  promisify(execFile)(cmd, args, { env: env ? { ...process.env, ...env } : process.env });

/** Structured representation of a parsed repository reference. */
export interface RepoRef {
  host: string;    // e.g. "github.com" (lowercased)
  owner: string;   // e.g. "acme" (original case preserved; comparison is case-insensitive)
  name: string;    // e.g. "widget" (original case preserved; comparison is case-insensitive)
}

// Only allow chars that GitHub/GHE accept in owner and repo names.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parse a repo reference into { host, owner, name }.
 * Returns null for anything that cannot be parsed safely.
 *
 * Handles:
 *   owner/name                              → host defaults to github.com
 *   https://host/owner/name(.git)
 *   git@host:owner/name(.git)
 *
 * Rejects if:
 *   - owner or name is empty
 *   - owner or name contains chars outside [A-Za-z0-9._-]
 *   - owner or name starts with "-" (would be treated as a flag by git/gh)
 */
export function parseRepoRef(ref: string): RepoRef | null {
  if (!ref || typeof ref !== "string") return null;

  let host: string;
  let owner: string;
  let name: string;

  // ── git@host:owner/name(.git) ──
  const sshMatch = ref.match(/^[^@]+@([^:/]+):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    host = sshMatch[1].toLowerCase();
    owner = sshMatch[2];
    name = sshMatch[3];
  } else if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(ref)) {
    // ── https://host/owner/name(.git) (or any URL scheme) ──
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return null;
    }
    host = url.hostname.toLowerCase();
    if (!host) return null;
    const parts = url.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    owner = parts[parts.length - 2];
    name = parts[parts.length - 1];
  } else {
    // ── owner/name (bare, no host) ──
    const bareMatch = ref.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (!bareMatch) return null;
    host = "github.com";
    owner = bareMatch[1];
    name = bareMatch[2];
  }

  // Validate segments.
  if (!owner || !name) return null;
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(name)) return null;
  if (owner.startsWith("-") || name.startsWith("-")) return null;

  return { host, owner, name };
}

/**
 * Returns true if repoRef matches any entry in the allowlist.
 * A bare allowlist entry `owner/name` implicitly uses host `github.com`.
 * The comparison is: exact host match (case-insensitive) AND exact owner/name
 * match (case-insensitive). Anything unparseable on either side → not allowed.
 */
export function isRepoAllowed(repoRef: string, allowlist: string[]): boolean {
  const ref = parseRepoRef(repoRef);
  if (!ref) return false;
  return allowlist.some((entry) => {
    const a = parseRepoRef(entry);
    if (!a) return false;
    return (
      ref.host === a.host &&
      ref.owner.toLowerCase() === a.owner.toLowerCase() &&
      ref.name.toLowerCase() === a.name.toLowerCase()
    );
  });
}

/**
 * Clone a repo that is in the allowlist (or pull + checkout if already cloned).
 * Returns the local path of the clone.
 *
 * Authentication uses a GitHub OAuth token via GIT_ASKPASS — the token is
 * never placed on the command line or in .git/config.
 *
 * The clone target is ALWAYS reconstructed from the parsed ref so that a
 * malicious raw string (e.g. one starting with "-") can never reach the shell.
 */
export async function cloneAllowedRepo(
  repoRef: string,
  opts: { allowlist: string[]; sourceDir: string; baseBranch: string; token: string },
  exec: Exec = pexec,
): Promise<string> {
  const parsed = parseRepoRef(repoRef);
  if (!parsed || !isRepoAllowed(repoRef, opts.allowlist)) {
    throw new Error(`Repo "${repoRef}" is not in the allowlist`);
  }
  mkdirSync(opts.sourceDir, { recursive: true });
  const target = join(opts.sourceDir, parsed.name);
  const url = `https://${parsed.host}/${parsed.owner}/${parsed.name}`;
  // Token-carrying calls are network-only and hardened (no repo hooks, no
  // credential helpers, https only) via authGit; the token is scoped to this host.
  const auth = (args: string[]) => authGit(args, opts.token, parsed.host);

  if (existsSync(join(target, ".git"))) {
    // Never fetch into (and hand the token to) a directory that holds some
    // other repository — refuse and leave it untouched.
    const out = await exec("git", ["-C", target, "remote", "get-url", "origin"]);
    const origin = String(out?.stdout ?? "").trim();
    if (normalizeRemote(origin) !== normalizeRemote(url)) {
      throw new Error(`${target} already holds a different repository (origin ${redactUrlCredentials(origin) || "unset"}, expected ${url}); move it away or choose another source directory`);
    }
    const f = auth(["-C", target, "fetch", "origin"]);
    await exec("git", f.args, f.env);
  } else {
    const c = auth(["clone", "--", url, target]);
    await exec("git", c.args, c.env);
  }
  // `git switch` (not checkout) has no pathspec ambiguity, and `--` guards a
  // baseBranch that might begin with `-` from being read as a flag
  // (defence-in-depth; baseBranch is also Zod-refined). Local only: no token,
  // since it runs the repo's post-checkout hook.
  await exec("git", ["-C", target, "switch", "--", opts.baseBranch]);
  return target;
}

/** Compare remotes ignoring case, one trailing "/" and a trailing ".git". */
function normalizeRemote(u: string): string {
  return u.trim().toLowerCase().replace(/\/$/, "").replace(/\.git$/, "");
}
