import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertSafeRef } from "./validate.js";

const pexec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd });
  return stdout.trim();
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

export async function startBranch(
  cwd: string,
  opts: { base: string; prefix: string; idea: string },
): Promise<string> {
  assertSafeRef(opts.base, "base");
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
