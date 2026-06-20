import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./init.js";
import { loadConfig } from "../config/config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tweaklet-"));
  process.env.TWEAKLET_HOME = home;
});
afterEach(() => {
  delete process.env.TWEAKLET_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("runInit", () => {
  it("writes a valid, loadable config and generates a session secret", () => {
    runInit({ githubClientId: "cid", githubClientSecret: "sec", publicUrl: "http://localhost:4319", port: 4319 });
    const cfg = loadConfig();
    expect(cfg.github!.clientId).toBe("cid");
    expect(cfg.github!.oauthBaseUrl).toBe("https://github.com");
    expect(cfg.server.publicUrl).toBe("http://localhost:4319");
    expect(cfg.server.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts a GitHub Enterprise Server base URL", () => {
    runInit({ githubClientId: "cid", githubClientSecret: "sec", publicUrl: "http://x:4319", port: 4319, githubOauthBaseUrl: "https://ghe.acme.com", githubApiBaseUrl: "https://ghe.acme.com/api/v3" });
    expect(loadConfig().github!.apiBaseUrl).toBe("https://ghe.acme.com/api/v3");
  });

  it("writes a minimal server-only config when GitHub creds are omitted (the fresh-box wizard path)", () => {
    const path = runInit({ publicUrl: "http://localhost:4319", port: 4319 });
    expect(path).toBeTruthy();
    const cfg = loadConfig();
    // No GitHub yet — the wizard captures it via POST /setup/github.
    expect(cfg.github).toBeUndefined();
    // …but the config is still valid + serve-able.
    expect(cfg.server.publicUrl).toBe("http://localhost:4319");
    expect(cfg.server.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(cfg.setup.completed).toBe(false);
  });
});
