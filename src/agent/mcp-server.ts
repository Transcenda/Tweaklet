import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Router, RequestHandler, Request, Response } from "express";
import { requestDomInspect } from "./dom-inspect.js";

/**
 * Build the Tweaklet DOM-inspect MCP server exposing the `dom_query` tool.
 *
 * `dom_query` rides the live round-trip: it calls `requestDomInspect`, which
 * emits a `dom_inspect` SSE frame on the active prompt's channel and resolves
 * when the widget answers via POST /agent/dom-result (or times out). When no
 * prompt is active (no live widget channel) the round-trip resolves to
 * `{ exists: false }`.
 */
export function buildDomMcpServer(): McpServer {
  const server = new McpServer({ name: "tweaklet-dom", version: "0.0.1" });

  server.registerTool(
    "dom_query",
    {
      title: "Query the live DOM",
      description:
        "Inspect an element in the running app's DOM by CSS selector. " +
        "Returns whether it exists plus its text and outer HTML.",
      inputSchema: { selector: z.string() },
    },
    async ({ selector }) => {
      const r = await requestDomInspect(selector);
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] };
    },
  );

  // Thin variant; full multi-element support is out of scope for now — it rides
  // the same single-element round-trip as dom_query.
  server.registerTool(
    "dom_query_all",
    {
      title: "Query all matching DOM elements",
      description:
        "Inspect elements in the running app's DOM by CSS selector. " +
        "Currently returns the first match (multi-element support is forthcoming).",
      inputSchema: { selector: z.string() },
    },
    async ({ selector }) => {
      const r = await requestDomInspect(selector);
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }] };
    },
  );

  return server;
}

/**
 * Express handler that serves one MCP Streamable-HTTP request.
 *
 * Runs in stateless mode (no session id) — a fresh server + transport per
 * request, which is the SDK's documented pattern for stateless Streamable HTTP
 * and avoids keeping per-session state in this local single-user tool. Handles
 * both POST (JSON-RPC requests) and GET (optional SSE stream).
 */
export const domMcpHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
  const server = buildDomMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `MCP transport error: ${String(e)}` },
        id: null,
      });
    }
  }
};

/**
 * Mount the DOM-inspect MCP endpoint on an Express `router` at `mountPath`
 * (relative to wherever the router itself is mounted, e.g. `/mcp`). opencode
 * connects here as an MCP client.
 *
 * Apply any access guard (the server gates this behind a loopback-only check)
 * as router/route middleware before this; `mountDomMcp` only wires the verb
 * handlers.
 */
export function mountDomMcp(router: Router, mountPath: string): void {
  router.post(mountPath, domMcpHandler);
  router.get(mountPath, domMcpHandler);
}
