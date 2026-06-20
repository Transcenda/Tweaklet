import { describe, it, expect } from "vitest";
import { decidePermission } from "./decide.js";
const allow = ["frontend/src/**"];
describe("decidePermission", () => {
  it("approves edits fully inside the allow-globs", () => {
    expect(decidePermission({ permission: "edit", patterns: ["frontend/src/App.tsx"] }, allow)).toBe("approve");
  });
  it("denies edits outside the allow-globs", () => {
    expect(decidePermission({ permission: "edit", patterns: ["backend/main.rs"] }, allow)).toBe("deny");
  });
  it("denies if ANY requested path is out of bounds", () => {
    expect(decidePermission({ permission: "edit", patterns: ["frontend/src/A.tsx", "Makefile"] }, allow)).toBe("deny");
  });
  it("asks for non-edit actions like bash", () => {
    expect(decidePermission({ permission: "bash", patterns: [] }, allow)).toBe("ask");
  });
  it("asks when an edit has no patterns (unknown scope)", () => {
    expect(decidePermission({ permission: "edit", patterns: [] }, allow)).toBe("ask");
  });
});
