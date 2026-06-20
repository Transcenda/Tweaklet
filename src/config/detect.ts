import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * A subprocess runner: takes a command + argv and returns stdout as a string.
 * Throws on non-zero exit or a missing binary (mirrors `execFileSync`). Injected
 * into the detect helpers so unit tests can supply a fake without spawning real
 * processes. `args` is always an explicit argv array — we never build a shell
 * string, so there's no shell-injection surface.
 */
export type Runner = (cmd: string, args: string[]) => string;

/** Default runner — runs the binary directly (no shell) and returns stdout. */
export const defaultRunner: Runner = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** First non-empty trimmed line of some text, or "" if there is none. */
function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/**
 * Repo root for `cwd` via `git rev-parse --show-toplevel`. Falls back to `cwd`
 * itself if git fails (not a repo / git missing) — a non-repo dir is still a
 * usable agent cwd.
 */
export function detectRepoPath(cwd: string, run: Runner = defaultRunner): string {
  try {
    const out = firstLine(run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]));
    return out || cwd;
  } catch {
    return cwd;
  }
}

/**
 * Default branch of `origin` via the `refs/remotes/origin/HEAD` symbolic ref,
 * stripped of the leading `origin/`. Falls back to `"main"` when there's no
 * remote / the ref isn't set.
 */
export function detectBaseBranch(repoPath: string, run: Runner = defaultRunner): string {
  try {
    const out = firstLine(
      run("git", ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    );
    const branch = out.replace(/^origin\//, "");
    return branch || "main";
  } catch {
    return "main";
  }
}

/**
 * Absolute path to the `opencode` binary via `which`. Falls back to the bare
 * `"opencode"` name (resolved against PATH at spawn time) if `which` fails.
 */
export function detectOpencode(run: Runner = defaultRunner): string {
  try {
    const out = firstLine(run("which", ["opencode"]));
    return out || "opencode";
  } catch {
    return "opencode";
  }
}

/**
 * Active GCP project from `gcloud config get-value project`. Returns `undefined`
 * when unset (gcloud prints `(unset)` or nothing) or when gcloud is missing.
 */
export function detectVertexProject(run: Runner = defaultRunner): string | undefined {
  try {
    const out = firstLine(run("gcloud", ["config", "get-value", "project"]));
    if (!out || out === "(unset)") return undefined;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Authenticated GitHub login via `gh api user --jq .login`. Returns `undefined`
 * when gh is missing or not logged in.
 */
export function detectGhLogin(run: Runner = defaultRunner): string | undefined {
  try {
    const out = firstLine(run("gh", ["api", "user", "--jq", ".login"]));
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** A fresh random session secret (48 hex chars — well over the 16-char min). */
export function generateSessionSecret(): string {
  return randomBytes(24).toString("hex");
}
