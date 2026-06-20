import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildDomMcpServer } from "./mcp-server.js";
import { setActivePrompt, resolveDomInspect } from "./dom-inspect.js";

/**
 * Connect the server to an in-memory transport pair (no HTTP server) and drive
 * it with a real MCP client — the lightest way to assert the wire-level tool
 * registration + handler output without standing up Express.
 */
async function connectedClient() {
  const server = buildDomMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("buildDomMcpServer", () => {
  it("registers a tool named dom_query with a selector input", async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    const dom = tools.find((t) => t.name === "dom_query");
    expect(dom).toBeTruthy();
    expect(dom!.inputSchema.properties).toHaveProperty("selector");
  });

  it("dom_query round-trips through the active widget channel", async () => {
    const { client } = await connectedClient();
    const sent: any[] = [];
    // resolveDomInspect reads the active ctx's pending map — pass the SAME map
    // that requestDomInspect populates.
    const pending = new Map();
    setActivePrompt({ send: (e) => sent.push(e), pending });
    try {
      // Call the tool WITHOUT awaiting, then answer the emitted request.
      const callP = client.callTool({ name: "dom_query", arguments: { selector: "h1" } });
      // Wait a tick for requestDomInspect to emit the dom_inspect frame.
      await new Promise((r) => setTimeout(r, 20));
      const ev = sent.find((e) => e.type === "dom_inspect");
      expect(ev?.selector).toBe("h1");
      resolveDomInspect(ev.requestId, { exists: true, text: "Hi" });
      const out = await callP;
      const content = out.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual({ exists: true, text: "Hi" });
    } finally {
      setActivePrompt(null);
    }
  });

  it("dom_query returns { exists: false } when no widget channel is active", async () => {
    const { client } = await connectedClient();
    setActivePrompt(null);
    const res = await client.callTool({ name: "dom_query", arguments: { selector: "#app" } });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text)).toEqual({ exists: false });
  });
});
