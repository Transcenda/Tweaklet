import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertSafeRef } from "./validate.js";
import { tokenGitEnv } from "./token-git.js";

const pexec = promisify(execFile);

/** Run git with an optional extra env (merged over process.env). Used for
 *  authenticated remote operations via {@link tokenGitEnv}. */
async function gitEnv(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd, env: env ? { ...process.env, ...env } : undefined });
  return stdout.trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  return gitEnv(cwd, args);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "idea"
  );
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Best-effort refresh of the LOCAL base branch from origin, so a new change is
 * cut from a fresh tree (the working clone otherwise drifts behind origin/main
 * and inherits a stale base). Authenticated via {@link tokenGitEnv}.
 *
 * Intentionally NEVER throws: if origin is unreachable (offline / no remote /
 * auth failure) we log a concise warning and return, letting the caller fall
 * back to the (possibly stale) local base. Freshness is best-effort, not a hard
 * dependency — failing here must not block starting a change.
 */
export async function syncBase(cwd: string, base: string, token: string): Promise<void> {
  assertSafeRef(base, "base");
  try {
    await gitEnv(cwd, ["fetch", "origin", base], tokenGitEnv(token));
    await git(cwd, ["checkout", base]);
    await git(cwd, ["merge", "--ff-only", `origin/${base}`]);
  } catch (e) {
    process.stderr.write(`tweaklet: syncBase(${base}) skipped — ${String(e).split("\n")[0]}\n`);
  }
}

export interface SyncResult {
  status: "updated" | "up-to-date" | "dirty" | "conflict";
  conflicts?: string[];
}

// TODO(branch-sync): two deliberate follow-ups, designed later, NOT built here:
//   1. A periodic background timer that auto-syncs the active branch — needs an
//      active-holder / whose-token model plus a dirty-tree policy before it's safe.
//   2. Agent-assisted conflict resolution (prompting opencode to resolve). For now
//      conflicts are surfaced verbatim as { status: "conflict", conflicts } and the
//      tree is left clean; we never auto-resolve.
/**
 * Merge the latest origin/<base> INTO the current feature branch, conflict-safe.
 * - Refuses to run on a dirty tree (returns "dirty") so it can never merge over
 *   uncommitted edits.
 * - Returns "up-to-date" when origin/<base> is already an ancestor of HEAD.
 * - On a clean merge, returns "updated".
 * - On conflict, collects the conflicted paths, ABORTS the merge (never leaves a
 *   partial/conflicted tree, never auto-resolves), and returns "conflict".
 */
export async function syncIntoBranch(cwd: string, base: string, token: string): Promise<SyncResult> {
  if (await isDirty(cwd)) return { status: "dirty" };
  assertSafeRef(base, "base");
  await gitEnv(cwd, ["fetch", "origin", base], tokenGitEnv(token));
  // Already contains origin/<base>? Nothing to merge.
  try {
    await git(cwd, ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"]);
    return { status: "up-to-date" };
  } catch {
    // non-zero exit → not an ancestor → there is something to merge.
  }
  try {
    await gitEnv(cwd, ["merge", "--no-edit", `origin/${base}`], tokenGitEnv(token));
    return { status: "updated" };
  } catch {
    let conflicts: string[] = [];
    try {
      const out = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
      conflicts = out ? out.split("\n").filter(Boolean) : [];
    } catch { /* fall through to abort regardless */ }
    await git(cwd, ["merge", "--abort"]);
    return { status: "conflict", conflicts };
  }
}

export async function startBranch(
  cwd: string,
  opts: { base: string; prefix: string; idea: string; token: string },
): Promise<string> {
  assertSafeRef(opts.base, "base");
  // Refresh the local base from origin first (best-effort) so the new branch is
  // cut from a fresh tree rather than a stale local base.
  await syncBase(cwd, opts.base, opts.token);
  const branch = `${opts.prefix}${slugify(opts.idea)}`;
  await git(cwd, ["checkout", opts.base]);
  await git(cwd, ["checkout", "-B", branch]);
  return branch;
}

export interface CommitAuthor { name: string; email: string; }

export async function checkpoint(cwd: string, message: string, author: CommitAuthor): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message]);
}

export async function discard(cwd: string): Promise<void> {
  await git(cwd, ["reset", "--hard", "HEAD"]);
  await git(cwd, ["clean", "-fd"]);
}

/**
 * Reject the agent's work: throw away all changes (committed checkpoints AND
 * uncommitted edits) and return to the base branch. Used by the panel's "Reject
 * changes" button. Deletes the sandbox branch we were on, but only when it's a
 * prefixed throwaway branch (never the base) so this can't nuke main.
 */
export async function reject(
  cwd: string,
  opts: { base: string; prefix: string },
): Promise<void> {
  assertSafeRef(opts.base, "base");
  const branch = await currentBranch(cwd);
  // Wipe uncommitted + untracked so the checkout can't be blocked.
  await git(cwd, ["reset", "--hard", "HEAD"]);
  await git(cwd, ["clean", "-fd"]);
  await git(cwd, ["checkout", opts.base]);
  // Drop the abandoned sandbox branch — guarded to a prefixed, non-base branch.
  if (branch !== opts.base && opts.prefix && branch.startsWith(opts.prefix)) {
    await git(cwd, ["branch", "-D", branch]);
  }
}

export interface SavedPoint { sha: string; message: string; relativeTime: string; }
export interface BranchState { branch: string; base: string; onFeature: boolean; commits: SavedPoint[]; }

export async function branchState(cwd: string, base: string): Promise<BranchState> {
  assertSafeRef(base, "base");
  const branch = await currentBranch(cwd);
  const onFeature = branch !== base;
  let commits: SavedPoint[] = [];
  if (onFeature) {
    const out = await git(cwd, ["log", `${base}..HEAD`, "--format=%H%x1f%s%x1f%cr"]);
    commits = out
      ? out.split("\n").map((line) => {
          const [sha, message, relativeTime] = line.split("\x1f");
          return { sha, message, relativeTime };
        })
      : [];
  }
  return { branch, base, onFeature, commits };
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])).length > 0;
}

/** Show an older commit's exact tree in the working dir (detached HEAD) without
 *  moving the branch. Requires a clean tree (caller enforces "Save first"). */
export async function previewCommit(cwd: string, sha: string): Promise<void> {
  assertSafeRef(sha, "sha");
  await git(cwd, ["checkout", sha]);
}

/** Leave preview: re-attach to the branch tip. */
export async function exitPreview(cwd: string, branch: string): Promise<void> {
  assertSafeRef(branch, "branch");
  await git(cwd, ["checkout", branch]);
}

/** Non-destructive restore: add a NEW commit on `branch` whose tree equals `sha`.
 *  read-tree -u --reset sets index + working tree to sha's tree (removing files
 *  not present in sha) without moving HEAD; the commit records it on the branch
 *  tip, preserving all existing history. */
export async function restoreCommit(cwd: string, branch: string, sha: string, author: CommitAuthor): Promise<void> {
  assertSafeRef(branch, "branch");
  assertSafeRef(sha, "sha");
  await git(cwd, ["checkout", branch]);
  await git(cwd, ["read-tree", "-u", "--reset", sha]);
  const subject = await git(cwd, ["log", "-1", "--format=%s", sha]);
  await git(cwd, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", `Restore to "${subject}"`]);
}
