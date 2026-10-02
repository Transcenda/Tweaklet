import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertSafeRef, assertSha } from "./validate.js";
import { authGit } from "./token-git.js";

const pexec = promisify(execFile);

/** Run git with an optional extra env (merged over process.env). */
async function gitEnv(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd, env: env ? { ...process.env, ...env } : undefined });
  return stdout.trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  return gitEnv(cwd, args);
}

/** An authenticated (network) git call: hardened argv + host-scoped token env
 *  via {@link authGit}. Only fetch/push go through here — local operations
 *  (merge, checkout, commit) run repo hooks and must never see the token. */
async function gitAuth(cwd: string, args: string[], token: string, host?: string): Promise<string> {
  const a = authGit(args, token, host);
  return gitEnv(cwd, a.args, a.env);
}

/** `git fetch origin <base>`: with the user's token (hardened, https only) when
 *  we have one, otherwise with the host's own git setup — never prompting. */
async function fetchOrigin(cwd: string, base: string, token: string, host?: string, quiet = false): Promise<void> {
  const args = ["fetch", ...(quiet ? ["--quiet"] : []), "origin", base];
  if (token) await gitAuth(cwd, args, token, host);
  else await gitEnv(cwd, args, { GIT_TERMINAL_PROMPT: "0" });
}

// Linear-time: no `-+$` (polynomial backtracking on long dash runs). After the
// first replace there are no consecutive dashes, so single-dash trims suffice;
// the last trim drops a dash that truncation may leave at the end.
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50)
      .replace(/-$/, "") || "idea"
  );
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Best-effort refresh of the LOCAL base branch from origin, so a new change is
 * cut from a fresh tree (the working clone otherwise drifts behind origin/main
 * and inherits a stale base). Authenticated via {@link authGit}.
 *
 * Intentionally NEVER throws: if origin is unreachable (offline / no remote /
 * auth failure) we log a concise warning and return, letting the caller fall
 * back to the (possibly stale) local base. Freshness is best-effort, not a hard
 * dependency — failing here must not block starting a change.
 */
export async function syncBase(cwd: string, base: string, token: string, gitHost?: string): Promise<void> {
  assertSafeRef(base, "base");
  try {
    await fetchOrigin(cwd, base, token, gitHost);
    await git(cwd, ["switch", "-q", base]);
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
export async function syncIntoBranch(cwd: string, base: string, token: string, gitHost?: string): Promise<SyncResult> {
  if (await isDirty(cwd)) return { status: "dirty" };
  assertSafeRef(base, "base");
  await fetchOrigin(cwd, base, token, gitHost);
  // Already contains origin/<base>? Nothing to merge.
  try {
    await git(cwd, ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"]);
    return { status: "up-to-date" };
  } catch {
    // non-zero exit → not an ancestor → there is something to merge.
  }
  try {
    // Local merge: no network, so no token (it would be visible to merge hooks).
    await git(cwd, ["merge", "--no-edit", `origin/${base}`]);
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

export interface CommitAuthor { name: string; email: string; }

/** Fallback identity for auto-saves when the holder has no GitHub identity
 *  (local / CLI auth). Only used for WIP commits on a Tweaklet branch. */
const AUTOSAVE_AUTHOR: CommitAuthor = { name: "Tweaklet", email: "tweaklet@localhost" };
const AUTOSAVE_MESSAGE = "Work in progress (auto-saved)";

/** Is `branch` a Tweaklet change branch (prefixed, never the base)? */
function isChangeBranch(branch: string, o: { base: string; prefix: string }): boolean {
  return !!o.prefix && branch !== o.base && branch.startsWith(o.prefix) && branch.length > o.prefix.length;
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try { await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); return true; }
  catch { return false; }
}

/**
 * Leave the working tree clean before moving HEAD, without ever losing work:
 * on a change branch, unsaved edits are committed as a WIP save; anywhere else
 * (the base, a detached preview) they are discarded — the base must stay
 * pristine. Also clears a half-finished merge/rebase.
 */
async function settleTree(cwd: string, o: { base: string; prefix: string; author?: CommitAuthor }): Promise<void> {
  for (const abort of [["merge", "--abort"], ["rebase", "--abort"], ["cherry-pick", "--abort"]]) {
    try { await git(cwd, abort); } catch { /* nothing in progress */ }
  }
  const branch = await currentBranch(cwd);
  if (isChangeBranch(branch, o) && await isDirty(cwd)) {
    // --no-verify: the repo's own hooks (husky / commitlint) must not be able to
    // turn an auto-save into data loss. If saving still fails, STOP — never fall
    // back to discarding someone's unsaved work.
    const a = o.author ?? AUTOSAVE_AUTHOR;
    try {
      await git(cwd, ["add", "-A"]);
      await git(cwd, ["-c", `user.name=${a.name}`, "-c", `user.email=${a.email}`, "commit", "-q", "--no-verify", "-m", AUTOSAVE_MESSAGE]);
    } catch (e) {
      throw new Error(`couldn't auto-save the unsaved edits on ${branch} — nothing was changed (${String(e).split("\n")[0]})`);
    }
    return;
  }
  await git(cwd, ["reset", "-q", "--hard", "HEAD"]);
  await git(cwd, ["clean", "-fdq"]);
}

/** Fetch origin/<base>. Uses the holder's token when we have one, the host's
 *  own git credentials otherwise; never prompts. Returns whether it worked. */
async function fetchBase(cwd: string, base: string, token: string, gitHost?: string): Promise<boolean> {
  try {
    await fetchOrigin(cwd, base, token, gitHost, true);
    return true;
  } catch (e) {
    process.stderr.write(`tweaklet: fetch origin/${base} failed — ${String(e).split("\n")[0]}\n`);
    return false;
  }
}

async function aheadOf(cwd: string, base: string, branch: string): Promise<number> {
  return Number(await git(cwd, ["rev-list", "--count", `${base}..${branch}`])) || 0;
}

async function uniqueBranchName(cwd: string, wanted: string): Promise<string> {
  if (!(await branchExists(cwd, wanted))) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted}-${i}`;
    if (!(await branchExists(cwd, candidate))) return candidate;
  }
}

export interface StartResult {
  branch: string;
  title: string;
  /** false when origin couldn't be fetched — the change was cut from the last-known base. */
  synced: boolean;
}

/**
 * Start a change on a FRESH branch cut from the latest base:
 *  1. settle the current tree (auto-save a change's edits / discard stray base edits),
 *  2. fetch origin/<base> and hard-reset the local base to it (drops any
 *     local-only commits on the base — nothing is ever built on the base),
 *  3. prune empty changes (no saves) so the list stays meaningful,
 *  4. cut a uniquely-named branch (never clobbers an existing change) and
 *     record the human title in `branch.<name>.description`.
 * Never throws for an unreachable origin — reports `synced: false` instead.
 */
export async function startBranch(
  cwd: string,
  opts: { base: string; prefix: string; idea: string; token: string; author?: CommitAuthor; owner?: string; gitHost?: string },
): Promise<StartResult> {
  assertSafeRef(opts.base, "base");
  await settleTree(cwd, opts);
  const synced = await fetchBase(cwd, opts.base, opts.token, opts.gitHost);
  if (synced) {
    await rescueLocalBaseCommits(cwd, opts);
    await git(cwd, ["switch", "-q", "-C", opts.base, `origin/${opts.base}`]);
  } else {
    await git(cwd, ["switch", "-q", opts.base]);
  }
  await pruneEmptyBranches(cwd, opts);
  // Leading dashes stripped so the title can never read as a `git config` flag.
  const title = opts.idea.trim().replace(/\s+/g, " ").replace(/^-+\s*/, "").slice(0, 120) || "New change";
  const branch = await uniqueBranchName(cwd, `${opts.prefix}${slugify(title)}`);
  assertSafeRef(branch, "branch");
  await git(cwd, ["switch", "-q", "-c", branch]);
  await git(cwd, ["config", `branch.${branch}.description`, title]);
  if (opts.owner) await git(cwd, ["config", `branch.${branch}.tweakletOwner`, opts.owner]);
  return { branch, title, synced };
}

/** Before the base is hard-reset to origin, move any local-only commits on it
 *  (e.g. saves made on the base by an older Tweaklet) onto a recovery change,
 *  so resetting can never destroy committed work. */
async function rescueLocalBaseCommits(cwd: string, o: { base: string; prefix: string }): Promise<void> {
  if (!(await branchExists(cwd, o.base))) return;
  const ahead = Number(await git(cwd, ["rev-list", "--count", `origin/${o.base}..${o.base}`])) || 0;
  if (ahead === 0) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const name = await uniqueBranchName(cwd, `${o.prefix}recovered-${slugify(o.base)}-${stamp}`);
  await git(cwd, ["branch", name, o.base]);
  await git(cwd, ["config", `branch.${name}.description`, `Recovered work from ${o.base} (${ahead} save${ahead === 1 ? "" : "s"})`]);
}

async function pruneEmptyBranches(cwd: string, o: { base: string; prefix: string }): Promise<void> {
  const current = await currentBranch(cwd);
  for (const name of await changeBranchNames(cwd, o)) {
    if (name === current) continue;
    if ((await aheadOf(cwd, o.base, name)) === 0) await git(cwd, ["branch", "-q", "-D", name]);
  }
}

async function changeBranchNames(cwd: string, o: { base: string; prefix: string }): Promise<string[]> {
  const out = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  return out ? out.split("\n").filter((n) => isChangeBranch(n, o)) : [];
}

function humanize(branch: string, prefix: string): string {
  const s = branch.slice(prefix.length).replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : branch;
}

/** `branch.<name>.<key>` for every branch, as a name → value map. */
async function branchConfig(cwd: string, key: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const cfg = await git(cwd, ["config", "--get-regexp", `^branch\\..*\\.${key}$`]);
    for (const line of cfg.split("\n")) {
      const m = line.match(new RegExp(`^branch\\.(.+)\\.${key} (.*)$`, "i"));
      if (m) map.set(m[1], m[2]);
    }
  } catch { /* none set → exit 1 */ }
  return map;
}

/** Who started a change (GitHub login), or null for changes made before owners were recorded. */
export async function branchOwner(cwd: string, branch: string): Promise<string | null> {
  assertSafeRef(branch, "branch");
  try { return (await git(cwd, ["config", "--get", `branch.${branch}.tweakletOwner`])) || null; }
  catch { return null; }
}

export interface ChangeBranch {
  name: string;
  title: string;
  /** GitHub login of whoever started it (null for older changes). */
  owner: string | null;
  /** Saves = commits on the change beyond the base. */
  saves: number;
  /** Relative time of the last commit ("2 hours ago"). */
  updated: string;
  current: boolean;
  /** Unsaved edits — only ever true for the current change. */
  dirty: boolean;
}

/** Every Tweaklet change in the clone, most recently updated first. */
export async function listBranches(cwd: string, o: { base: string; prefix: string }): Promise<ChangeBranch[]> {
  assertSafeRef(o.base, "base");
  const out = await git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(committerdate:relative)", "refs/heads/"]);
  const titles = await branchConfig(cwd, "description");
  const owners = await branchConfig(cwd, "tweakletowner"); // git lower-cases config keys
  const current = await currentBranch(cwd);
  const dirty = await isDirty(cwd);
  const rows = out ? out.split("\n").map((l) => l.split("\x1f")) : [];
  const result: ChangeBranch[] = [];
  for (const [name, updated] of rows) {
    if (!isChangeBranch(name, o)) continue;
    result.push({
      name,
      title: titles.get(name) ?? humanize(name, o.prefix),
      owner: owners.get(name) ?? null,
      saves: await aheadOf(cwd, o.base, name),
      updated,
      current: name === current,
      dirty: name === current && dirty,
    });
  }
  return result;
}

/** Switch to another change (or the base). The current change's unsaved edits
 *  are auto-saved first, so switching never loses work. */
export async function switchBranch(
  cwd: string,
  branch: string,
  o: { base: string; prefix: string; author?: CommitAuthor },
): Promise<void> {
  assertSafeRef(branch, "branch");
  if (branch !== o.base && !isChangeBranch(branch, o)) throw new Error(`"${branch}" is not a Tweaklet change`);
  if (!(await branchExists(cwd, branch))) throw new Error(`no such change: ${branch}`);
  await settleTree(cwd, o);
  await git(cwd, ["switch", "-q", branch]);
}

/** Delete a change for good. Deleting the current change discards its edits
 *  and returns to a clean base. Refuses the base and non-Tweaklet branches. */
export async function deleteBranch(cwd: string, branch: string, o: { base: string; prefix: string }): Promise<void> {
  assertSafeRef(branch, "branch");
  if (!isChangeBranch(branch, o)) throw new Error(`"${branch}" is not a Tweaklet change`);
  if (!(await branchExists(cwd, branch))) throw new Error(`no such change: ${branch}`);
  if ((await currentBranch(cwd)) === branch) {
    await git(cwd, ["reset", "-q", "--hard", "HEAD"]);
    await git(cwd, ["clean", "-fdq"]);
    await git(cwd, ["switch", "-q", o.base]);
  }
  await git(cwd, ["branch", "-q", "-D", branch]);
}

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
  await git(cwd, ["switch", "-q", opts.base]);
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

/** Every path a change touches relative to where it left `base` — added,
 *  modified, deleted, and both sides of a rename. Used to refuse a PR that
 *  reaches outside the guardrails. */
export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  assertSafeRef(base, "base");
  const out = await git(cwd, ["diff", "--no-renames", "--name-only", "-z", `${base}...HEAD`, "--"]);
  return out.split("\0").filter(Boolean);
}

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])).length > 0;
}

/**
 * Resolve a commit id from a request to a full sha, refusing anything that is
 * not a commit reachable from `tip` (a save on the current change or its base).
 * Stops a request from previewing/restoring arbitrary objects, e.g. another
 * user's change.
 */
async function resolveSave(cwd: string, sha: string, tip: string): Promise<string> {
  assertSha(sha);
  let full: string;
  try {
    full = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`]);
  } catch {
    throw new Error(`not a save on this change: ${sha}`);
  }
  try {
    await git(cwd, ["merge-base", "--is-ancestor", "--end-of-options", full, tip]);
  } catch {
    throw new Error(`not a save on this change: ${sha}`);
  }
  return full;
}

/** Show an older commit's exact tree in the working dir (detached HEAD) without
 *  moving the branch. Requires a clean tree (caller enforces "Save first").
 *  `sha` must be a save on `branch` (default: the current HEAD). */
export async function previewCommit(cwd: string, sha: string, branch?: string): Promise<void> {
  if (branch !== undefined) assertSafeRef(branch, "branch");
  const full = await resolveSave(cwd, sha, branch ? `refs/heads/${branch}` : "HEAD");
  await git(cwd, ["switch", "-q", "--detach", full]);
}

/** Leave preview: re-attach to the branch tip. */
export async function exitPreview(cwd: string, branch: string): Promise<void> {
  assertSafeRef(branch, "branch");
  await git(cwd, ["switch", "-q", branch]);
}

/** Non-destructive restore: add a NEW commit on `branch` whose tree equals `sha`.
 *  read-tree -u --reset sets index + working tree to sha's tree (removing files
 *  not present in sha) without moving HEAD; the commit records it on the branch
 *  tip, preserving all existing history. */
export async function restoreCommit(cwd: string, branch: string, sha: string, author: CommitAuthor): Promise<void> {
  assertSafeRef(branch, "branch");
  const full = await resolveSave(cwd, sha, `refs/heads/${branch}`);
  await git(cwd, ["switch", "-q", branch]);
  await git(cwd, ["read-tree", "-u", "--reset", full]);
  const subject = await git(cwd, ["log", "-1", "--format=%s", full, "--"]);
  await git(cwd, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", `Restore to "${subject}"`]);
}
