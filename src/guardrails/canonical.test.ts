import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalRepoPath, matchesAllow } from "./guardrails.js";

// A real repo-shaped tree with symlinks committed under the allowed directory.
// The root is deliberately NOT realpath'd (on macOS the tmp dir is itself
// behind a symlink), so the helper has to canonicalise the root too.
let tmp: string;
let repo: string;
let outside: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tweaklet-canon-"));
  repo = path.join(tmp, "repo");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(repo, "frontend/src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "backend"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git/hooks"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(repo, "frontend/src/App.tsx"), "");
  fs.writeFileSync(path.join(repo, "backend/secret.rs"), "");
  fs.writeFileSync(path.join(repo, ".git/config"), "");
  fs.symlinkSync("../../backend", path.join(repo, "frontend/src/escape"));
  fs.symlinkSync("../../.git", path.join(repo, "frontend/src/gitlink"));
  fs.symlinkSync(outside, path.join(repo, "frontend/src/out"));
  fs.symlinkSync("../../backend/new.rs", path.join(repo, "frontend/src/dangling"));
  fs.symlinkSync("App.tsx", path.join(repo, "frontend/src/alias.tsx"));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("canonicalRepoPath", () => {
  it("returns the repo-relative path for ordinary files, existing or new", () => {
    expect(canonicalRepoPath(repo, "frontend/src/App.tsx")).toBe("frontend/src/App.tsx");
    expect(canonicalRepoPath(repo, "frontend/src/new/deep/X.tsx")).toBe("frontend/src/new/deep/X.tsx");
    expect(canonicalRepoPath(repo, "frontend/src/./a/../App.tsx")).toBe("frontend/src/App.tsx");
  });

  it("resolves a symlinked directory to where it really points", () => {
    expect(canonicalRepoPath(repo, "frontend/src/escape/secret.rs")).toBe("backend/secret.rs");
    expect(canonicalRepoPath(repo, "frontend/src/escape/new.rs")).toBe("backend/new.rs");
    expect(canonicalRepoPath(repo, "frontend/src/gitlink/hooks/pre-commit")).toBe(".git/hooks/pre-commit");
    expect(canonicalRepoPath(repo, "frontend/src/alias.tsx")).toBe("frontend/src/App.tsx");
  });

  it("fails closed for symlinks that leave the repo, dangling symlinks, and lexical escapes", () => {
    expect(canonicalRepoPath(repo, "frontend/src/out/x.txt")).toBeNull();
    expect(canonicalRepoPath(repo, "frontend/src/dangling")).toBeNull();
    expect(canonicalRepoPath(repo, "../outside/x.txt")).toBeNull();
    expect(canonicalRepoPath(repo, "/etc/passwd")).toBeNull();
    expect(canonicalRepoPath(repo, "")).toBeNull();
  });

  it("fails closed when the repo root cannot be resolved", () => {
    expect(canonicalRepoPath(path.join(tmp, "missing"), "frontend/src/App.tsx")).toBeNull();
  });

  it("accepts an injected realpath (e.g. for tests without a filesystem)", () => {
    const realpath = (p: string) => {
      if (p === "/r") return "/r";
      if (p === "/r/ui") return "/r";               // ui -> repo root
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const lstat = (p: string) => { if (p === "/r/ui") return {}; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
    expect(canonicalRepoPath("/r", "ui/x.ts", { realpath, lstat })).toBe("x.ts");
  });
});

describe("matchesAllow — .git is never editable", () => {
  it("denies any path inside a .git directory, whatever the allow globs say", () => {
    expect(matchesAllow(".git/config", ["**"])).toBe(false);
    expect(matchesAllow(".git/hooks/pre-commit", [".git/**"])).toBe(false);
    expect(matchesAllow("frontend/src/.git/config", ["frontend/src/**"])).toBe(false);
    expect(matchesAllow(".GIT/config", ["**"])).toBe(false); // case-insensitive filesystems
    expect(matchesAllow("frontend/src/.gitignore", ["frontend/src/**"])).toBe(true);
  });
});
