import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, startBranch, checkpoint, discard, reject, slugify, branchState, previewCommit, exitPreview, restoreCommit, isDirty, syncBase, syncIntoBranch, listBranches, switchBranch, deleteBranch } from "./repo.js";

let dir: string;
function git(...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apz-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.dev"); git("config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "-A"); git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("repo", () => {
  it("slugify makes a branch-safe slug", () => {
    expect(slugify("Make the box BIGGER!")).toBe("make-the-box-bigger");
  });

  it("currentBranch reports the checked-out branch", async () => {
    expect(await currentBranch(dir)).toBe("main");
  });

  it("startBranch creates a prefixed branch from base (no user segment)", async () => {
    const { branch } = await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "Bigger box", token: "x" });
    expect(branch).toBe("tweaklet/bigger-box");
    expect(await currentBranch(dir)).toBe("tweaklet/bigger-box");
  });

  it("checkpoint commits all working changes", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    writeFileSync(join(dir, "a.txt"), "new\n");
    await checkpoint(dir, "wip", { name: "T", email: "t@x.com" });
    expect(git("log", "--oneline", "-1")).toContain("wip");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("discard resets working changes to HEAD", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    writeFileSync(join(dir, "README.md"), "tampered\n");
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    await discard(dir);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("reject discards committed + uncommitted work, returns to base, drops the sandbox branch", async () => {
    const { branch } = await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    writeFileSync(join(dir, "a.txt"), "committed\n");
    await checkpoint(dir, "agent work", { name: "T", email: "t@x.com" }); // committed change on the sandbox branch
    writeFileSync(join(dir, "b.txt"), "uncommitted\n"); // plus a dirty working tree
    await reject(dir, { base: "main", prefix: "tweaklet/" });
    expect(await currentBranch(dir)).toBe("main"); // back on base
    expect(git("status", "--porcelain")).toBe(""); // clean tree
    expect(git("ls-files")).toBe("README.md"); // main never saw the agent's files
    expect(() => git("rev-parse", "--verify", branch)).toThrow(); // sandbox branch deleted
  });

  it("reject never deletes the base branch when already on it", async () => {
    await reject(dir, { base: "main", prefix: "sandbox/" });
    expect(await currentBranch(dir)).toBe("main");
    expect(git("rev-parse", "--verify", "main")).toBeTruthy(); // still there
  });

  it("branchState lists only this branch's commits since base, newest first", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    writeFileSync(join(dir, "a.txt"), "1\n"); await checkpoint(dir, "first", { name: "T", email: "t@x.com" });
    writeFileSync(join(dir, "a.txt"), "2\n"); await checkpoint(dir, "second", { name: "T", email: "t@x.com" });
    const st = await branchState(dir, "main");
    expect(st.onFeature).toBe(true);
    expect(st.branch).toBe("tweaklet/x");
    expect(st.commits.map((c) => c.message)).toEqual(["second", "first"]);
    expect(st.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("branchState on base reports no feature branch and no commits", async () => {
    const st = await branchState(dir, "main");
    expect(st.onFeature).toBe(false);
    expect(st.commits).toEqual([]);
  });

  it("previewCommit shows an older tree, exitPreview returns to the tip", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    writeFileSync(join(dir, "a.txt"), "one\n"); await checkpoint(dir, "first", { name: "T", email: "t@x.com" });
    const first = (await branchState(dir, "main")).commits[0].sha;
    writeFileSync(join(dir, "a.txt"), "two\n"); await checkpoint(dir, "second", { name: "T", email: "t@x.com" });

    await previewCommit(dir, first);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");

    await exitPreview(dir, "tweaklet/x");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two\n");
    expect(await currentBranch(dir)).toBe("tweaklet/x");
  });

  it("restoreCommit makes a new tip whose tree equals the target; nothing is lost", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    writeFileSync(join(dir, "a.txt"), "one\n"); await checkpoint(dir, "first", { name: "T", email: "t@x.com" });
    const first = (await branchState(dir, "main")).commits[0].sha;
    writeFileSync(join(dir, "a.txt"), "two\n"); writeFileSync(join(dir, "b.txt"), "added\n"); await checkpoint(dir, "second", { name: "T", email: "t@x.com" });

    await restoreCommit(dir, "tweaklet/x", first, { name: "T", email: "t@x.com" });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    const msgs = (await branchState(dir, "main")).commits.map((c) => c.message);
    expect(msgs).toContain("first");
    expect(msgs).toContain("second");
    expect(msgs.length).toBe(3);
  });

  it("isDirty reflects uncommitted changes", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    expect(await isDirty(dir)).toBe(false);
    writeFileSync(join(dir, "a.txt"), "x\n");
    expect(await isDirty(dir)).toBe(true);
  });

  it("checkpoint authors the commit as the given user", async () => {
    // (reuse the file's existing beforeEach/temp-repo `dir`)
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    await (await import("node:fs")).promises.writeFile(`${dir}/f.txt`, "hi");
    await checkpoint(dir, "msg", { name: "Alice A", email: "alice@x.com" });
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const out = await promisify(execFile)("git", ["-C", dir, "log", "-1", "--format=%an <%ae>"]);
    expect(out.stdout.trim()).toBe("Alice A <alice@x.com>");
  });
});

// ── Base sync (real git against a LOCAL origin) ──────────────────────────────
// `tokenGitEnv` injects GIT_ASKPASS, but a local-path "origin" never prompts for
// auth, so a dummy token ("x") is harmless. We model a real remote: a bare repo
// as `origin`, a clone that tracks it, and commits pushed to origin out-of-band.
describe("syncBase / syncIntoBranch", () => {
  let origin: string;  // bare "remote"
  let clone: string;   // working clone
  function g(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
  function commitFileOnOrigin(name: string, contents: string, msg: string) {
    // Use a throwaway scratch checkout of origin to add a commit on main, then push.
    const scratch = mkdtempSync(join(tmpdir(), "apz-scratch-"));
    g(scratch, "clone", "-q", origin, ".");
    g(scratch, "config", "user.email", "o@o.dev"); g(scratch, "config", "user.name", "O");
    writeFileSync(join(scratch, name), contents);
    g(scratch, "add", "-A"); g(scratch, "commit", "-q", "-m", msg);
    g(scratch, "push", "-q", "origin", "main");
    rmSync(scratch, { recursive: true, force: true });
  }

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), "apz-origin-"));
    g(origin, "init", "-q", "--bare", "-b", "main");
    // Seed origin with an initial commit on main.
    const seed = mkdtempSync(join(tmpdir(), "apz-seed-"));
    g(seed, "clone", "-q", origin, ".");
    g(seed, "config", "user.email", "o@o.dev"); g(seed, "config", "user.name", "O");
    writeFileSync(join(seed, "README.md"), "hello\n");
    g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "init"); g(seed, "push", "-q", "origin", "main");
    rmSync(seed, { recursive: true, force: true });
    // The working clone under test.
    clone = mkdtempSync(join(tmpdir(), "apz-clone-"));
    g(clone, "clone", "-q", origin, ".");
    g(clone, "config", "user.email", "t@t.dev"); g(clone, "config", "user.name", "T");
  });
  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  it("syncBase fast-forwards the local base after origin advances", async () => {
    const before = g(clone, "rev-parse", "main");
    commitFileOnOrigin("a.txt", "from origin\n", "origin advances");
    await syncBase(clone, "main", "x");
    expect(await currentBranch(clone)).toBe("main");
    expect(g(clone, "rev-parse", "main")).not.toBe(before);
    expect(readFileSync(join(clone, "a.txt"), "utf8")).toBe("from origin\n");
  });

  it("startBranch cuts the new branch from a freshly-fetched base", async () => {
    commitFileOnOrigin("fresh.txt", "new\n", "origin advances");
    const { branch, synced } = await startBranch(clone, { base: "main", prefix: "tweaklet/", idea: "thing", token: "x" });
    expect(branch).toBe("tweaklet/thing");
    expect(synced).toBe(true);
    // The freshly-pulled origin file is present on the new branch.
    expect(existsSync(join(clone, "fresh.txt"))).toBe(true);
  });

  it("syncIntoBranch returns up-to-date when nothing new on origin", async () => {
    await startBranch(clone, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    expect(await syncIntoBranch(clone, "main", "x")).toEqual({ status: "up-to-date" });
  });

  it("syncIntoBranch merges new base commits into the feature branch (updated)", async () => {
    await startBranch(clone, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    writeFileSync(join(clone, "feature.txt"), "mine\n");
    await checkpoint(clone, "my work", { name: "T", email: "t@t.dev" });
    commitFileOnOrigin("upstream.txt", "theirs\n", "origin advances");
    const result = await syncIntoBranch(clone, "main", "x");
    expect(result).toEqual({ status: "updated" });
    // Both the upstream file and my work survive the merge.
    expect(existsSync(join(clone, "upstream.txt"))).toBe(true);
    expect(existsSync(join(clone, "feature.txt"))).toBe(true);
  });

  it("syncIntoBranch refuses to merge over a dirty tree", async () => {
    await startBranch(clone, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    commitFileOnOrigin("upstream.txt", "theirs\n", "origin advances");
    writeFileSync(join(clone, "dirty.txt"), "uncommitted\n"); // dirty working tree
    expect(await syncIntoBranch(clone, "main", "x")).toEqual({ status: "dirty" });
    // Nothing merged; the working file is untouched and origin's file absent.
    expect(readFileSync(join(clone, "dirty.txt"), "utf8")).toBe("uncommitted\n");
    expect(existsSync(join(clone, "upstream.txt"))).toBe(false);
  });

  it("syncIntoBranch surfaces a conflict and leaves a CLEAN, non-conflicted tree", async () => {
    await startBranch(clone, { base: "main", prefix: "tweaklet/", idea: "x", token: "x" });
    // Both sides edit README.md divergently → merge conflict.
    writeFileSync(join(clone, "README.md"), "feature edit\n");
    await checkpoint(clone, "feature edits README", { name: "T", email: "t@t.dev" });
    commitFileOnOrigin("README.md", "upstream edit\n", "origin edits README");
    const result = await syncIntoBranch(clone, "main", "x");
    expect(result.status).toBe("conflict");
    expect(result.conflicts).toContain("README.md");
    // The merge was aborted: tree is clean, no UU entries, feature content intact.
    const status = g(clone, "status", "--porcelain");
    expect(status).not.toMatch(/^UU/m);
    expect(status).toBe("");
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("feature edit\n");
  });
});

// ── Branch workspace: fresh starts, list / switch / delete ───────────────────
describe("branch workspace", () => {
  let origin: string;
  let clone: string;
  const me = { name: "T", email: "t@t.dev" };
  const opts = { base: "main", prefix: "tweaklet/" };
  function g(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
  function pushOnOrigin(name: string, contents: string) {
    const scratch = mkdtempSync(join(tmpdir(), "apz-scratch-"));
    g(scratch, "clone", "-q", origin, ".");
    g(scratch, "config", "user.email", "o@o.dev"); g(scratch, "config", "user.name", "O");
    writeFileSync(join(scratch, name), contents);
    g(scratch, "add", "-A"); g(scratch, "commit", "-q", "-m", `add ${name}`); g(scratch, "push", "-q", "origin", "main");
    rmSync(scratch, { recursive: true, force: true });
  }
  const start = (idea: string) => startBranch(clone, { ...opts, idea, token: "", author: me });
  async function save(file: string, msg: string) { writeFileSync(join(clone, file), msg + "\n"); await checkpoint(clone, msg, me); }

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), "apz-origin-"));
    g(origin, "init", "-q", "--bare", "-b", "main");
    clone = mkdtempSync(join(tmpdir(), "apz-clone-"));
    g(clone, "clone", "-q", origin, ".");
    g(clone, "config", "user.email", "t@t.dev"); g(clone, "config", "user.name", "T");
    writeFileSync(join(clone, "README.md"), "hello\n");
    g(clone, "add", "-A"); g(clone, "commit", "-q", "-m", "init"); g(clone, "push", "-q", "origin", "main");
  });
  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });

  it("a fresh start on the base discards stray local edits so the change starts clean", async () => {
    writeFileSync(join(clone, "README.md"), "agent edited main directly\n");
    writeFileSync(join(clone, "stray.txt"), "untracked\n");
    const { branch } = await start("Login copy");
    expect(branch).toBe("tweaklet/login-copy");
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(clone, "stray.txt"))).toBe(false);
    expect(g(clone, "status", "--porcelain")).toBe("");
  });

  it("a fresh start resets the local base to origin, dropping local-only base commits", async () => {
    writeFileSync(join(clone, "local.txt"), "never pushed\n");
    g(clone, "add", "-A"); g(clone, "commit", "-q", "-m", "local-only commit on main");
    pushOnOrigin("upstream.txt", "theirs\n");
    const { synced } = await start("Next");
    expect(synced).toBe(true);
    expect(g(clone, "rev-parse", "main")).toBe(g(clone, "rev-parse", "origin/main"));
    expect(existsSync(join(clone, "upstream.txt"))).toBe(true);
    expect(existsSync(join(clone, "local.txt"))).toBe(false);
  });

  it("reports synced:false (and still starts) when origin is unreachable", async () => {
    g(clone, "remote", "set-url", "origin", join(tmpdir(), "does-not-exist-" + Date.now()));
    const { branch, synced } = await start("Offline");
    expect(synced).toBe(false);
    expect(await currentBranch(clone)).toBe(branch);
  });

  it("starting a new change from a change with unsaved edits auto-saves them there", async () => {
    const { branch: first } = await start("First");
    writeFileSync(join(clone, "wip.txt"), "unsaved agent edit\n");
    await start("Second");
    expect(g(clone, "show", `${first}:wip.txt`)).toBe("unsaved agent edit");
    expect(existsSync(join(clone, "wip.txt"))).toBe(false); // not carried into the new change
  });

  it("never clobbers an existing change with the same name", async () => {
    const { branch: a } = await start("Same idea");
    await save("a.txt", "keep me");
    const { branch: b } = await start("Same idea");
    expect(a).toBe("tweaklet/same-idea");
    expect(b).toBe("tweaklet/same-idea-2");
    expect(g(clone, "log", "-1", "--format=%s", a)).toBe("keep me");
  });

  it("prunes empty changes (no saves) but keeps changes with work", async () => {
    await start("Empty one");
    const { branch: kept } = await start("Has work");
    await save("w.txt", "work");
    await start("Third");
    const names = (await listBranches(clone, opts)).map((b) => b.name);
    expect(names).not.toContain("tweaklet/empty-one");
    expect(names).toContain(kept);
  });

  it("listBranches shows title, saves, current + dirty, newest first, prefixed only", async () => {
    g(clone, "branch", "someone-else");
    const { branch: older } = await start("Bigger buttons");
    await save("a.txt", "one"); await save("a.txt", "two");
    g(clone, "commit", "--amend", "-q", "--no-edit", "--date=2000-01-01T00:00:00", "--reset-author");
    execFileSync("git", ["commit", "--amend", "-q", "--no-edit"], { cwd: clone, env: { ...process.env, GIT_COMMITTER_DATE: "2000-01-01T00:00:00" } });
    const { branch: newer } = await start("Login copy");
    await save("b.txt", "three");
    writeFileSync(join(clone, "b.txt"), "dirty\n");
    const list = await listBranches(clone, opts);
    expect(list.map((b) => b.name)).toEqual([newer, older]);
    expect(list[0]).toMatchObject({ title: "Login copy", saves: 1, current: true, dirty: true });
    expect(list[1]).toMatchObject({ title: "Bigger buttons", saves: 2, current: false, dirty: false });
    expect(typeof list[0].updated).toBe("string");
  });

  it("switchBranch auto-saves the current change, then checks out the target", async () => {
    const { branch: a } = await start("A");
    await save("a.txt", "a");
    const { branch: b } = await start("B");
    writeFileSync(join(clone, "b.txt"), "unsaved\n");
    await switchBranch(clone, a, { ...opts, author: me });
    expect(await currentBranch(clone)).toBe(a);
    expect(existsSync(join(clone, "b.txt"))).toBe(false);
    expect(g(clone, "show", `${b}:b.txt`)).toBe("unsaved");
  });

  it("switchBranch to the base discards nothing on the change and lands on a clean base", async () => {
    const { branch: a } = await start("A");
    await save("a.txt", "a");
    await switchBranch(clone, "main", { ...opts, author: me });
    expect(await currentBranch(clone)).toBe("main");
    expect(g(clone, "log", "-1", "--format=%s", a)).toBe("a");
  });

  it("switchBranch refuses branches outside the prefix and unknown branches", async () => {
    g(clone, "branch", "release");
    await expect(switchBranch(clone, "release", { ...opts, author: me })).rejects.toThrow(/not a Tweaklet change/);
    await expect(switchBranch(clone, "tweaklet/nope", { ...opts, author: me })).rejects.toThrow(/no such change/);
  });

  it("deleteBranch removes a change; deleting the current one returns to a clean base", async () => {
    const { branch: a } = await start("A");
    await save("a.txt", "a");
    const { branch: b } = await start("B");
    await save("b.txt", "b");
    writeFileSync(join(clone, "b.txt"), "dirty\n");
    await deleteBranch(clone, a, opts);
    expect(() => g(clone, "rev-parse", "--verify", a)).toThrow();
    expect(await currentBranch(clone)).toBe(b);
    await deleteBranch(clone, b, opts);
    expect(await currentBranch(clone)).toBe("main");
    expect(g(clone, "status", "--porcelain")).toBe("");
    expect(() => g(clone, "rev-parse", "--verify", b)).toThrow();
  });

  it("deleteBranch never deletes the base or a non-prefixed branch", async () => {
    g(clone, "branch", "release");
    await expect(deleteBranch(clone, "main", opts)).rejects.toThrow(/not a Tweaklet change/);
    await expect(deleteBranch(clone, "release", opts)).rejects.toThrow(/not a Tweaklet change/);
    expect(g(clone, "rev-parse", "--verify", "release")).toBeTruthy();
  });
});
