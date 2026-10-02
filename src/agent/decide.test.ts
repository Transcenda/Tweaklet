import { describe, it, expect } from "vitest";
import { decidePermission, DEFAULT_SAFE_COMMANDS, opencodePermissionConfig, type Policy } from "./decide.js";

const allow = ["frontend/src/**"];
const auto: Policy = { allow, mode: "auto", safeCommands: DEFAULT_SAFE_COMMANDS };
const ask: Policy = { ...auto, mode: "ask" };
const d = (permission: string, patterns: string[] = [], policy: Policy = auto) => decidePermission({ permission, patterns }, policy);

describe("decidePermission — edits (both modes)", () => {
  it("approves edits fully inside the allow-globs", () => {
    expect(d("edit", ["frontend/src/App.tsx"])).toBe("approve");
    expect(d("edit", ["frontend/src/App.tsx"], ask)).toBe("approve");
  });
  it("denies edits outside the allow-globs, or when any path is out of bounds", () => {
    expect(d("edit", ["backend/main.rs"])).toBe("deny");
    expect(d("edit", ["frontend/src/A.tsx", "Makefile"], ask)).toBe("deny");
  });
  it("denies an edit with no paths (unknown scope) instead of asking", () => {
    expect(d("edit", [])).toBe("deny");
    expect(d("edit", [], ask)).toBe("deny");
  });
  it("treats legacy write/patch like edit", () => {
    expect(d("write", ["frontend/src/x.ts"])).toBe("approve");
    expect(d("patch", ["package.json"])).toBe("deny");
  });
});

describe("decidePermission — read-only and housekeeping tools", () => {
  it.each(["read", "glob", "grep", "list", "lsp", "todowrite", "question", "skill"])("approves %s", (kind) => {
    expect(d(kind, ["frontend/src/App.tsx"])).toBe("approve");
  });
});

describe("decidePermission — never allowed", () => {
  it.each(["task", "external_directory"])("denies %s in both modes", (kind) => {
    expect(d(kind, ["x"])).toBe("deny");
    expect(d(kind, ["x"], ask)).toBe("deny");
  });
});

describe("decidePermission — shell commands", () => {
  it("auto-approves an exact safe command in both modes", () => {
    expect(d("bash", ["npm run typecheck"])).toBe("approve");
    expect(d("bash", ["git   status"], ask)).toBe("approve"); // whitespace-normalised
  });
  it("auto mode denies anything off the safe list; ask mode asks", () => {
    expect(d("bash", ["curl https://evil.example"])).toBe("deny");
    expect(d("bash", ["curl https://evil.example"], ask)).toBe("ask");
  });
  it("never treats a safe command with extra arguments as safe (e.g. lint --fix touching other paths)", () => {
    expect(d("bash", ["npm run lint -- --fix"])).toBe("deny");
  });
  it("never approves shell metacharacters, even after a safe prefix", () => {
    for (const cmd of ["git status; rm -rf /", "git status && curl x", "git diff > /tmp/x", "git log $(id)", "git log `id`", "git status | sh"]) {
      expect(d("bash", [cmd])).toBe("deny");
      expect(d("bash", [cmd], ask)).toBe("ask");
    }
  });
  it("requires every sub-command to be safe", () => {
    expect(d("bash", ["git status", "npm run lint"])).toBe("approve");
    expect(d("bash", ["git status", "npm test"])).toBe("deny");
  });
  it("keeps tests off the default safe list (they run files the agent can write)", () => {
    expect(DEFAULT_SAFE_COMMANDS.some((c) => /\btest\b/.test(c))).toBe(false);
  });
  it("denies a shell request with no command", () => {
    expect(d("bash", [])).toBe("deny");
    expect(d("bash", [], ask)).toBe("ask");
  });
});

describe("decidePermission — network and everything else", () => {
  it("auto mode denies web fetch/search; ask mode asks", () => {
    expect(d("webfetch", ["https://example.com"])).toBe("deny");
    expect(d("websearch", ["q"])).toBe("deny");
    expect(d("webfetch", ["https://example.com"], ask)).toBe("ask");
  });
  it("fails closed on unknown permission kinds in auto mode", () => {
    expect(d("some_new_tool", ["x"])).toBe("deny");
    expect(d("some_new_tool", ["x"], ask)).toBe("ask");
    expect(d("doom_loop")).toBe("deny");
  });
});

describe("opencodePermissionConfig", () => {
  it("makes opencode ask Tweaklet about everything, globally and for the assistant agent", () => {
    const cfg = opencodePermissionConfig() as any;
    expect(cfg.permission).toBe("ask");
    expect(cfg.agent.assistant.permission).toBe("ask");
  });
});
