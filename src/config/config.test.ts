import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, configExists, ConfigSchema, type TweakletConfig } from "./config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tweaklet-"));
  process.env.TWEAKLET_HOME = home;
});
afterEach(() => {
  delete process.env.TWEAKLET_HOME;
  rmSync(home, { recursive: true, force: true });
});

const valid: TweakletConfig = {
  github: {
    clientId: "cid",
    clientSecret: "secret",
    oauthBaseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
  },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "x".repeat(32), basePath: "/tweaklet" },
  guardrails: { allow: ["frontend/src/**"] },
  setup: { completed: false },
};

describe("config", () => {
  it("round-trips save → load", () => {
    expect(configExists()).toBe(false);
    saveConfig(valid);
    expect(configExists()).toBe(true);
    expect(loadConfig()).toEqual(valid);
  });

  it("throws a clear error when missing", () => {
    expect(() => loadConfig()).toThrow(/no tweaklet config/i);
  });

  it("rejects an invalid config", () => {
    saveConfig(valid);
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(home, ".tweaklet", "config.json"), JSON.stringify({ github: {} }));
    expect(() => loadConfig()).toThrow();
  });

  it("writes the config file owner-only (0600) on POSIX", () => {
    if (process.platform === "win32") return; // file-mode semantics differ on Windows
    const { statSync } = require("node:fs");
    saveConfig(valid);
    const mode = statSync(join(home, ".tweaklet", "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("accepts and round-trips an optional agent block", () => {
    const withAgent = {
      ...valid,
      agent: { command: "gemini", cwd: "/home/tweaklet/app", vertexProject: "my-gcp-proj" },
    };
    saveConfig(withAgent);
    const loaded = loadConfig();
    expect(loaded.agent).toEqual({ command: "gemini", cwd: "/home/tweaklet/app", vertexProject: "my-gcp-proj" });
  });

  it("still loads a config with no agent block (agent is optional)", () => {
    saveConfig(valid); // `valid` has no agent block
    expect(loadConfig().agent).toBeUndefined();
  });

  it("round-trips optional repo + run blocks", () => {
    const cfg = {
      ...valid,
      repo: { path: "/home/tweaklet/app", baseBranch: "main", branchPrefix: "sandbox/", prTarget: "main" },
      run: { liveUpdate: "rebuild-swap" as const, rebuildCommand: "make build" },
    };
    saveConfig(cfg);
    const loaded = loadConfig();
    expect(loaded.repo).toEqual({ ...cfg.repo, allowlist: [] });
    expect(loaded.run).toEqual({ liveUpdate: "rebuild-swap", rebuildCommand: "make build" });
  });

  it("defaults run.liveUpdate to hot-reload", () => {
    saveConfig({ ...valid, run: {} } as any);
    expect(loadConfig().run?.liveUpdate).toBe("hot-reload");
  });

  it("parses successfully without a github block (github is optional)", () => {
    const noGithub = {
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "x".repeat(32) },
    };
    saveConfig(noGithub as any);
    const loaded = loadConfig();
    expect(loaded.github).toBeUndefined();
    expect(loaded.server.port).toBe(4319);
  });

  it("parses successfully with an access allowlist", () => {
    const withAccess = {
      ...valid,
      access: { allowedLogins: ["alice"] },
    };
    saveConfig(withAccess);
    const loaded = loadConfig();
    expect(loaded.access?.allowedLogins).toEqual(["alice"]);
  });

  it("parses successfully without an access block (access is optional)", () => {
    saveConfig(valid);
    const loaded = loadConfig();
    expect(loaded.access).toBeUndefined();
  });

  it("defaults guardrails.allow to the UI source glob", () => {
    const cfg = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
    });
    expect(cfg.guardrails.allow).toEqual(["frontend/src/**"]);
  });

  it("accepts custom guardrails.allow", () => {
    const cfg = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
      guardrails: { allow: ["web/src/**", "ui/**"] },
    });
    expect(cfg.guardrails.allow).toEqual(["web/src/**", "ui/**"]);
  });

  // ── basePath charset validation ──────────────────────────────────────────

  it("accepts a clean basePath like /tw", () => {
    const cfg = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tw" },
    });
    expect(cfg.server.basePath).toBe("/tw");
  });

  it("accepts the default /tweaklet basePath", () => {
    const cfg = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
    });
    expect(cfg.server.basePath).toBe("/tweaklet");
  });

  it("accepts basePaths with allowed chars like /my-app_v2", () => {
    const cfg = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/my-app_v2" },
    });
    expect(cfg.server.basePath).toBe("/my-app_v2");
  });

  it("rejects basePath containing angle bracket (<)", () => {
    expect(() =>
      ConfigSchema.parse({
        server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/a<b" },
      }),
    ).toThrow(/basePath/i);
  });

  it("rejects basePath containing a space", () => {
    expect(() =>
      ConfigSchema.parse({
        server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/a b" },
      }),
    ).toThrow(/basePath/i);
  });

  it("rejects basePath containing a single-quote", () => {
    expect(() =>
      ConfigSchema.parse({
        server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/a'b" },
      }),
    ).toThrow(/basePath/i);
  });

  it("strips trailing slash before the charset check (normalization still works)", () => {
    const cfg = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tw/" },
    });
    expect(cfg.server.basePath).toBe("/tw");
  });

  it("adds leading slash before the charset check (normalization still works)", () => {
    const cfg = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "tw" },
    });
    expect(cfg.server.basePath).toBe("/tw");
  });

  it("accepts an optional preview block", () => {
    const c = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "https://x", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
      guardrails: { allow: ["frontend/src/**"] },
      setup: { completed: false },
      preview: { serviceName: "t8a-frontend-dev", subdir: "frontend", installCheckDir: "frontend/node_modules" },
    });
    expect(c.preview?.serviceName).toBe("t8a-frontend-dev");
  });

  it("preview is optional", () => {
    const c = ConfigSchema.parse({
      server: { port: 4319, publicUrl: "https://x", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
      guardrails: { allow: ["frontend/src/**"] },
      setup: { completed: false },
    });
    expect(c.preview).toBeUndefined();
  });
});
