import { mkdtempSync, writeFileSync, chmodSync, existsSync, openSync, closeSync, constants as FS } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Git invokes GIT_ASKPASS with the prompt text as $1, e.g.
//   Username for 'https://github.com':
//   Password for 'https://x-access-token@github.com':
// We answer ONLY when the prompt's URL is https on exactly the host the token
// was issued for ($TWEAKLET_GIT_HOST): a repo-controlled remote, submodule or
// redirect pointing elsewhere gets nothing. The authority is the text between
// "https://" and the first "/", minus any userinfo up to the LAST "@", so path
// tricks (`https://evil.example/x@github.com`) and lookalike hosts don't match.
// The token is NEVER on a command line or in .git/config.
const ASKPASS = `#!/bin/sh
[ -n "$TWEAKLET_GIT_HOST" ] || exit 0
url=\${1#*\\'}
url=\${url%\\'*}
case "$url" in
  https://*) ;;
  *) exit 0 ;;
esac
auth=\${url#https://}
auth=\${auth%%/*}
host=$(printf '%s' "\${auth##*@}" | tr 'A-Z' 'a-z')
[ "$host" = "$TWEAKLET_GIT_HOST" ] || exit 0
case "$1" in
  Username*) printf '%s' "x-access-token" ;;
  Password*) printf '%s' "$TWEAKLET_GIT_TOKEN" ;;
esac
`;

let askpassPath: string | null = null;

/** Write (once) the askpass helper and return its path. */
export function ensureAskpass(): string {
  if (askpassPath && existsSync(askpassPath)) return askpassPath;
  // Write into a per-process PRIVATE dir: mkdtempSync creates a 0700 directory
  // owned by the current uid with an unpredictable suffix, so a local attacker
  // can't pre-create or symlink the path (the askpass script is executed by git
  // and reads the OAuth token, so this matters). O_EXCL|O_NOFOLLOW is belt-and-
  // suspenders: fail rather than follow a symlink or clobber an existing file.
  const dir = mkdtempSync(join(tmpdir(), "tweaklet-"));
  const p = join(dir, "git-askpass.sh");
  const fd = openSync(p, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o700);
  try {
    writeFileSync(fd, ASKPASS);
  } finally {
    closeSync(fd);
  }
  chmodSync(p, 0o700);
  askpassPath = p;
  return p;
}

/** Env that makes git authenticate over HTTPS as `token` without persisting it.
 *  The askpass helper only hands the token to `https://<host>`. Prefer
 *  {@link authGit}, which also applies {@link GIT_AUTH_HARDENING}. */
export function tokenGitEnv(token: string, host = "github.com"): NodeJS.ProcessEnv {
  return {
    GIT_ASKPASS: ensureAskpass(),
    TWEAKLET_GIT_TOKEN: token,
    TWEAKLET_GIT_HOST: host.toLowerCase(),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Config for every git process that carries a user's token. The clone is shared
 * and its content (hooks such as .husky, repo config) is not trusted:
 * - no hooks and no fsmonitor command, so repo code never runs with the token in its env;
 * - no credential helpers, so the token is never cached (and replayed for the next user)
 *   and no helper supplies someone else's credentials;
 * - https only, so a remote can't route through `ext::`, `file` or other transports.
 */
export const GIT_AUTH_HARDENING: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=",
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
];

/** Prefix git argv with {@link GIT_AUTH_HARDENING} (global options, so they
 *  must come before the subcommand). */
export function authGitArgs(args: string[]): string[] {
  return [...GIT_AUTH_HARDENING, ...args];
}

/** The hardened argv + token env for one authenticated git call. Keeping them
 *  together means the token env can't be used without the hardening. */
export function authGit(args: string[], token: string, host = "github.com"): { args: string[]; env: NodeJS.ProcessEnv } {
  return { args: authGitArgs(args), env: tokenGitEnv(token, host) };
}

/** The git (web) host for a GitHub REST API base: `https://api.github.com` →
 *  `github.com`, `https://ghe.example.com/api/v3` → `ghe.example.com`. */
export function gitHostFromApiBase(apiBaseUrl: string): string {
  try {
    const host = new URL(apiBaseUrl).host.toLowerCase();
    return host.startsWith("api.") ? host.slice(4) : host;
  } catch {
    return "github.com";
  }
}
