import { describe, it, expect } from "vitest";
import {
  detectRepoPath,
  detectBaseBranch,
  detectOpencode,
  detectVertexProject,
  detectGhLogin,
  generateSessionSecret,
  type Runner,
} from "./detect.js";

/** A runner that returns a fixed string for any call. */
const ok = (out: string): Runner => () => out;
/** A runner that always throws (missing binary / non-zero exit). */
const fail: Runner = () => {
  throw new Error("boom");
};
/** A runner that records its calls and returns a fixed string. */
function spy(out: string): { run: Runner; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, args]);
      return out;
    },
  };
}

describe("detectRepoPath", () => {
  it("returns the trimmed toplevel on success", () => {
    expect(detectRepoPath("/some/cwd", ok("/repo/root\n"))).toBe("/repo/root");
  });
  it("invokes git with -C and rev-parse", () => {
    const s = spy("/repo/root\n");
    detectRepoPath("/some/cwd", s.run);
    expect(s.calls[0]).toEqual(["git", ["-C", "/some/cwd", "rev-parse", "--show-toplevel"]]);
  });
  it("falls back to cwd on failure", () => {
    expect(detectRepoPath("/some/cwd", fail)).toBe("/some/cwd");
  });
  it("falls back to cwd on empty output", () => {
    expect(detectRepoPath("/some/cwd", ok("\n"))).toBe("/some/cwd");
  });
});

describe("detectBaseBranch", () => {
  it("strips the origin/ prefix on success", () => {
    expect(detectBaseBranch("/repo", ok("origin/develop\n"))).toBe("develop");
  });
  it("handles a branch without origin/ prefix", () => {
    expect(detectBaseBranch("/repo", ok("trunk\n"))).toBe("trunk");
  });
  it("falls back to main on failure", () => {
    expect(detectBaseBranch("/repo", fail)).toBe("main");
  });
  it("falls back to main on empty output", () => {
    expect(detectBaseBranch("/repo", ok(""))).toBe("main");
  });
});

describe("detectOpencode", () => {
  it("returns the trimmed path on success", () => {
    expect(detectOpencode(ok("/usr/local/bin/opencode\n"))).toBe("/usr/local/bin/opencode");
  });
  it("uses only the first line", () => {
    expect(detectOpencode(ok("/a/opencode\n/b/opencode\n"))).toBe("/a/opencode");
  });
  it("falls back to bare name on failure", () => {
    expect(detectOpencode(fail)).toBe("opencode");
  });
});

describe("detectVertexProject", () => {
  it("returns the project on success", () => {
    expect(detectVertexProject(ok("my-gcp-proj\n"))).toBe("my-gcp-proj");
  });
  it("returns undefined when unset", () => {
    expect(detectVertexProject(ok("(unset)\n"))).toBeUndefined();
  });
  it("returns undefined on empty output", () => {
    expect(detectVertexProject(ok("\n"))).toBeUndefined();
  });
  it("returns undefined on failure", () => {
    expect(detectVertexProject(fail)).toBeUndefined();
  });
});

describe("detectGhLogin", () => {
  it("returns the login on success", () => {
    expect(detectGhLogin(ok("octocat\n"))).toBe("octocat");
  });
  it("returns undefined on empty output", () => {
    expect(detectGhLogin(ok(""))).toBeUndefined();
  });
  it("returns undefined on failure (not logged in / gh missing)", () => {
    expect(detectGhLogin(fail)).toBeUndefined();
  });
});

describe("generateSessionSecret", () => {
  it("produces 48 hex chars", () => {
    const s = generateSessionSecret();
    expect(s).toMatch(/^[0-9a-f]{48}$/);
  });
  it("produces a fresh value each call", () => {
    expect(generateSessionSecret()).not.toBe(generateSessionSecret());
  });
});
