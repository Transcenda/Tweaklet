import { describe, it, expect } from "vitest";
import { buildOpencodeProviderConfig, ensureOpencodeProvider, opencodeConfigPath } from "./provider-config.js";

describe("buildOpencodeProviderConfig", () => {
  it("builds a google-vertex-ai provider from the agent model + project/location", () => {
    const cfg = buildOpencodeProviderConfig({
      model: "google-vertex-ai/gemini-2.5-pro",
      vertexProject: "ai-adoption-488503",
      vertexLocation: "global",
    }) as any;
    expect(cfg.provider["google-vertex-ai"].npm).toBe("@ai-sdk/google-vertex");
    expect(cfg.provider["google-vertex-ai"].options).toEqual({ project: "ai-adoption-488503", location: "global" });
    // The configured model must be present so opencode resolves it.
    expect(cfg.provider["google-vertex-ai"].models["gemini-2.5-pro"]).toBeTruthy();
  });

  it("registers the tweaklet-dom remote MCP server pointing at loopback /<basePath>/mcp", () => {
    const cfg = buildOpencodeProviderConfig(
      { model: "google-vertex-ai/gemini-2.5-pro", vertexProject: "p" },
      { port: 4319, basePath: "/tweaklet" },
    ) as any;
    expect(cfg.mcp["tweaklet-dom"].type).toBe("remote");
    expect(cfg.mcp["tweaklet-dom"].enabled).toBe(true);
    expect(cfg.mcp["tweaklet-dom"].url).toBe("http://127.0.0.1:4319/tweaklet/mcp");
    expect(cfg.mcp["tweaklet-dom"].url.endsWith("/tweaklet/mcp")).toBe(true);
  });

  it("defaults the MCP url to port 4319 + /tweaklet when server coords are absent", () => {
    const cfg = buildOpencodeProviderConfig({ model: "google-vertex-ai/gemini-2.5-pro", vertexProject: "p" }) as any;
    expect(cfg.mcp["tweaklet-dom"].url).toBe("http://127.0.0.1:4319/tweaklet/mcp");
  });

  it("defaults location to 'global' when unset", () => {
    const cfg = buildOpencodeProviderConfig({ model: "google-vertex-ai/gemini-2.5-flash", vertexProject: "p" }) as any;
    expect(cfg.provider["google-vertex-ai"].options.location).toBe("global");
  });

  it("returns null for a non-managed provider (nothing to write)", () => {
    expect(buildOpencodeProviderConfig({ model: "anthropic/claude-opus", vertexProject: "p" })).toBeNull();
  });

  it("returns null when project is missing", () => {
    expect(buildOpencodeProviderConfig({ model: "google-vertex-ai/gemini-2.5-pro" })).toBeNull();
  });

  it("returns null when model is missing", () => {
    expect(buildOpencodeProviderConfig({ vertexProject: "p" })).toBeNull();
  });
});

describe("ensureOpencodeProvider", () => {
  it("writes the config and returns true for a managed model", () => {
    let writtenPath = "", writtenBody = "";
    const ok = ensureOpencodeProvider(
      { model: "google-vertex-ai/gemini-2.5-pro", vertexProject: "p", vertexLocation: "global" },
      {},
      { configPath: () => "/tmp/x/opencode.json", mkdir: (() => undefined) as any, write: ((p: string, b: string) => { writtenPath = p; writtenBody = b; }) as any },
    );
    expect(ok).toBe(true);
    expect(writtenPath).toBe("/tmp/x/opencode.json");
    expect(JSON.parse(writtenBody).provider["google-vertex-ai"].options.project).toBe("p");
  });

  it("does NOT write (returns false) for a non-managed model", () => {
    let wrote = false;
    const ok = ensureOpencodeProvider(
      { model: "anthropic/claude-opus", vertexProject: "p" },
      {},
      { configPath: () => "/tmp/x/opencode.json", mkdir: (() => undefined) as any, write: (() => { wrote = true; }) as any },
    );
    expect(ok).toBe(false);
    expect(wrote).toBe(false);
  });
});

describe("opencodeConfigPath", () => {
  it("ends in opencode/opencode.json", () => {
    expect(opencodeConfigPath().endsWith("opencode/opencode.json")).toBe(true);
  });
});
