import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** Path to opencode's global config (XDG). opencode loads providers from here. */
export function opencodeConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(base, "opencode", "opencode.json");
}

export interface AgentLike {
  model?: string;
  vertexProject?: string;
  vertexLocation?: string;
}

/** Server coordinates the agent's MCP block points opencode at. */
export interface ServerLike {
  port?: number;
  basePath?: string;
}

/** Defaults match config.ts (server.port has no default; 4319 is the Tweaklet default). */
const DEFAULT_MCP_PORT = 4319;
const DEFAULT_MCP_BASEPATH = "/tweaklet";

/**
 * Build the opencode provider config object for a Tweaklet agent config.
 * Returns null when the agent isn't a configured google-vertex-ai model (the
 * only provider Tweaklet manages today) — caller should not write in that case.
 *
 * Derives the provider id + model id from `agent.model` (e.g.
 * "google-vertex-ai/gemini-2.5-pro" → provider "google-vertex-ai", model
 * "gemini-2.5-pro") and the project/location from the agent config.
 *
 * Also registers Tweaklet's own remote MCP server ("tweaklet-dom") so opencode
 * discovers the `dom_query` tool. opencode runs on the same host, so we point it
 * at the loopback address; `server` supplies the port/basePath (defaults
 * 4319 + /tweaklet when not provided).
 */
export function buildOpencodeProviderConfig(
  agent: AgentLike,
  server: ServerLike = {},
): Record<string, unknown> | null {
  if (!agent.model) return null;
  const slash = agent.model.indexOf("/");
  const providerId = slash >= 0 ? agent.model.slice(0, slash) : "";
  const modelId = slash >= 0 ? agent.model.slice(slash + 1) : agent.model;
  if (providerId !== "google-vertex-ai" || !agent.vertexProject) return null;
  const port = server.port ?? DEFAULT_MCP_PORT;
  const basePath = server.basePath ?? DEFAULT_MCP_BASEPATH;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "google-vertex-ai": {
        npm: "@ai-sdk/google-vertex",
        name: "Google Vertex AI",
        options: { project: agent.vertexProject, location: agent.vertexLocation || "global" },
        // Include the configured model + the flash variant (cheap fallback).
        models: {
          [modelId]: { name: `${modelId} (Vertex)` },
          "gemini-2.5-flash": { name: "Gemini 2.5 Flash (Vertex)" },
        },
      },
    },
    mcp: {
      "tweaklet-dom": {
        type: "remote",
        url: `http://127.0.0.1:${port}${basePath}/mcp`,
        enabled: true,
      },
    },
  };
}

/**
 * Write opencode's provider config so the configured Vertex model resolves on a
 * from-scratch box (no hand-written opencode.json needed). No-op when the agent
 * isn't a managed google-vertex-ai model. `writeImpl`/`mkdirImpl` injected for tests.
 */
export function ensureOpencodeProvider(
  agent: AgentLike,
  server: ServerLike = {},
  deps: { configPath?: () => string; write?: typeof writeFileSync; mkdir?: typeof mkdirSync } = {},
): boolean {
  const cfg = buildOpencodeProviderConfig(agent, server);
  if (!cfg) return false;
  const p = (deps.configPath ?? opencodeConfigPath)();
  (deps.mkdir ?? mkdirSync)(dirname(p), { recursive: true });
  (deps.write ?? writeFileSync)(p, JSON.stringify(cfg, null, 2));
  return true;
}
