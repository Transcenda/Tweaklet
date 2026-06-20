export type AgentEvent =
  | { type: "init"; sessionId?: string; model?: string; raw: unknown }
  | { type: "message"; role?: string; text: string; raw: unknown }
  | { type: "tool_use"; toolName?: string; toolId?: string; title?: string; detail?: string; input?: unknown; output?: string; status?: string; raw: unknown }
  | { type: "tool_result"; toolId?: string; status?: string; title?: string; detail?: string; input?: unknown; output?: string; raw: unknown }
  | { type: "error"; message: string; raw: unknown }
  | { type: "result"; raw: unknown }
  | { type: "unknown"; raw: unknown };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof (p as any)?.text === "string" ? (p as any).text : ""))
      .join("");
  }
  if (content && typeof (content as any).text === "string") return (content as any).text;
  return "";
}

export function parseAgentLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null; // stray non-JSON stdout — ignore
  }
  if (!obj || typeof obj !== "object") return null;
  switch (obj.type) {
    case "init":
      return { type: "init", sessionId: obj.session_id ?? obj.sessionId, model: obj.model, raw: obj };
    case "message":
      return { type: "message", role: obj.role, text: extractText(obj.content), raw: obj };
    case "tool_use":
      return { type: "tool_use", toolName: obj.tool_name ?? obj.name, toolId: obj.tool_id ?? obj.id, raw: obj };
    case "tool_result":
      return { type: "tool_result", toolId: obj.tool_id ?? obj.id, status: obj.status, raw: obj };
    case "error":
      return { type: "error", message: String(obj.message ?? obj.error ?? "agent error"), raw: obj };
    case "result":
      return { type: "result", raw: obj };
    default:
      return { type: "unknown", raw: obj };
  }
}
