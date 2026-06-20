import { mkdtempSync, writeFileSync, chmodSync, existsSync, openSync, closeSync, constants as FS } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Git invokes GIT_ASKPASS with the prompt text as $1. Answer the username with
// the fixed PAT username; everything else (the password prompt) with the token
// from the env. The token is NEVER on a command line or in .git/config.
const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) printf '%s' "x-access-token" ;;
  *) printf '%s' "$TWEAKLET_GIT_TOKEN" ;;
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

/** Env that makes git authenticate over HTTPS as `token` without persisting it. */
export function tokenGitEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_ASKPASS: ensureAskpass(),
    TWEAKLET_GIT_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
  };
}
