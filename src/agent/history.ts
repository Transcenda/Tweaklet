import type { AgentEvent } from "./events.js";

function partText(p: any): string | null {
  if (p && p.type === "text" && typeof p.text === "string") return p.text;
  if (p && typeof p.text === "string" && !p.type) return p.text;
  return null;
}

function partTool(p: any): { name?: string } | null {
  if (!p) return null;
  if (p.type === "tool" || p.type === "tool_use" || p.type === "tool-invocation") {
    return { name: p.tool ?? p.name ?? p.toolName };
  }
  return null;
}

/**
 * Map opencode's stored session messages → the panel's AgentEvent[] for re-hydration.
 * Lenient by design (opencode message/part shapes drift): unknown parts are skipped.
 */
export function messagesToEvents(messages: any[]): AgentEvent[] {
  if (!Array.isArray(messages)) return [];
  const out: AgentEvent[] = [];
  for (const m of messages) {
    const role = m?.info?.role ?? m?.role;
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    for (const p of parts) {
      const t = partText(p);
      if (t && t.trim()) {
        out.push({ type: "message", role, text: t, raw: p });
        continue;
      }
      const tool = partTool(p);
      if (tool) {
        out.push({ type: "tool_use", toolName: tool.name, raw: p });
        continue;
      }
    }
  }
  return out;
}

/**
 * Fetch a session's messages from opencode (best-effort; [] on any error).
 *
 * The real SDK method is `client.session.messages({ path: { id } })`.
 * The test mock uses `client.session.messages(...)` directly — both are
 * satisfied by the same call below.
 */
export async function fetchSessionMessages(client: any, sessionId: string): Promise<any[]> {
  try {
    const r = await client?.session?.messages?.({ path: { id: sessionId } });
    const data = r?.data ?? r;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
