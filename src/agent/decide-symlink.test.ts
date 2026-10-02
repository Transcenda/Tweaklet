import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decidePermission, DEFAULT_SAFE_COMMANDS, type Policy } from "./decide.js";

// Symlinks committed inside the allowed directory must not let an edit land
// outside it: the allow check runs on where the path really points.
let tmp: string;
let repo: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tweaklet-decide-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "frontend/src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "backend"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, "frontend/src/App.tsx"), "");
  fs.symlinkSync("../../backend", path.join(repo, "frontend/src/x"));
  fs.symlinkSync("../../.git", path.join(repo, "frontend/src/g"));
  fs.symlinkSync(tmp, path.join(repo, "frontend/src/up"));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const policy = (over: Partial<Policy> = {}): Policy =>
  ({ allow: ["frontend/src/**"], mode: "auto", safeCommands: DEFAULT_SAFE_COMMANDS, repoRoot: repo, ...over });
const edit = (patterns: string[], p: Policy = policy()) => decidePermission({ permission: "edit", patterns }, p);

describe("decidePermission — edits through symlinks (repoRoot set)", () => {
  it("still approves ordinary in-bounds edits, existing or new", () => {
    expect(edit(["frontend/src/App.tsx"])).toBe("approve");
    expect(edit(["frontend/src/components/New.tsx"])).toBe("approve");
  });
  it("denies an edit whose path escapes the allowed dir via a symlink", () => {
    expect(edit(["frontend/src/x/main.rs"])).toBe("deny");
    expect(edit(["frontend/src/App.tsx", "frontend/src/x/main.rs"])).toBe("deny");
  });
  it("denies an edit that reaches .git via a symlink, in either mode", () => {
    expect(edit(["frontend/src/g/hooks/pre-commit"])).toBe("deny");
    expect(edit(["frontend/src/g/config"], policy({ mode: "ask" }))).toBe("deny");
  });
  it("denies an edit that leaves the repo via a symlink", () => {
    expect(edit(["frontend/src/up/elsewhere.txt"])).toBe("deny");
  });
  it("without repoRoot the check stays lexical (backwards compatible)", () => {
    expect(edit(["frontend/src/App.tsx"], policy({ repoRoot: undefined }))).toBe("approve");
  });
});
