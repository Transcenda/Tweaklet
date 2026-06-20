import { describe, it, expect } from "vitest";
import { matchesAllow, partitionChanges } from "./guardrails.js";

describe("guardrails", () => {
  it("matches ** globs", () => {
    expect(matchesAllow("frontend/src/app/X.tsx", ["frontend/src/**"])).toBe(true);
    expect(matchesAllow("frontend/src/X.tsx", ["frontend/src/**"])).toBe(true);
    expect(matchesAllow("backend/main.rs", ["frontend/src/**"])).toBe(false);
    expect(matchesAllow("frontend/index.html", ["frontend/src/**"])).toBe(false);
  });
  it("matches multiple allow globs", () => {
    expect(matchesAllow("ui/x.ts", ["web/src/**", "ui/**"])).toBe(true);
  });
  it("partitions changed paths", () => {
    const { allowed, blocked } = partitionChanges(
      ["frontend/src/App.tsx", "backend/Cargo.toml", "Makefile"],
      ["frontend/src/**"],
    );
    expect(allowed).toEqual(["frontend/src/App.tsx"]);
    expect(blocked).toEqual(["backend/Cargo.toml", "Makefile"]);
  });

  // Security: the glob's `.*` would otherwise let `..` walk out of the allowed
  // root. These must all be denied — the Build-mode decider trusts this.
  it("rejects path traversal that escapes the allow root", () => {
    const allow = ["frontend/src/**"];
    expect(matchesAllow("frontend/src/../../backend/secret.rs", allow)).toBe(false);
    expect(matchesAllow("frontend/src/../../../etc/passwd", allow)).toBe(false);
    expect(matchesAllow("frontend/src/../index.html", allow)).toBe(false); // escapes frontend/src
    expect(matchesAllow("/etc/passwd", allow)).toBe(false); // absolute
    expect(matchesAllow("C:/Windows/system32", allow)).toBe(false); // windows drive
    expect(matchesAllow("", allow)).toBe(false);
  });

  it("still allows normalized in-bounds paths", () => {
    expect(matchesAllow("frontend/src/./app/X.tsx", ["frontend/src/**"])).toBe(true);
    expect(matchesAllow("frontend/src/app/../app/Y.tsx", ["frontend/src/**"])).toBe(true);
  });

  it("blocks traversal inside partitionChanges", () => {
    const { allowed, blocked } = partitionChanges(
      ["frontend/src/App.tsx", "frontend/src/../../backend/x.rs"],
      ["frontend/src/**"],
    );
    expect(allowed).toEqual(["frontend/src/App.tsx"]);
    expect(blocked).toEqual(["frontend/src/../../backend/x.rs"]);
  });
});
