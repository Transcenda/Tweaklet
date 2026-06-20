import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, startBranch, checkpoint, discard, reject, slugify, branchState, previewCommit, exitPreview, restoreCommit, isDirty } from "./repo.js";

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
    const branch = await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "Bigger box" });
    expect(branch).toBe("tweaklet/bigger-box");
    expect(await currentBranch(dir)).toBe("tweaklet/bigger-box");
  });

  it("checkpoint commits all working changes", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    writeFileSync(join(dir, "a.txt"), "new\n");
    await checkpoint(dir, "wip", { name: "T", email: "t@x.com" });
    expect(git("log", "--oneline", "-1")).toContain("wip");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("discard resets working changes to HEAD", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    writeFileSync(join(dir, "README.md"), "tampered\n");
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    await discard(dir);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("reject discards committed + uncommitted work, returns to base, drops the sandbox branch", async () => {
    const branch = await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
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
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
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
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
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
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
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
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    expect(await isDirty(dir)).toBe(false);
    writeFileSync(join(dir, "a.txt"), "x\n");
    expect(await isDirty(dir)).toBe(true);
  });

  it("checkpoint authors the commit as the given user", async () => {
    // (reuse the file's existing beforeEach/temp-repo `dir`)
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    await (await import("node:fs")).promises.writeFile(`${dir}/f.txt`, "hi");
    await checkpoint(dir, "msg", { name: "Alice A", email: "alice@x.com" });
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const out = await promisify(execFile)("git", ["-C", dir, "log", "-1", "--format=%an <%ae>"]);
    expect(out.stdout.trim()).toBe("Alice A <alice@x.com>");
  });
});
