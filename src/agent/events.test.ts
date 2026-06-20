import { describe, it, expect } from "vitest";
import { parseAgentLine, type AgentEvent } from "./events.js";

describe("parseAgentLine", () => {
  it("returns null for blank or whitespace lines", () => {
    expect(parseAgentLine("")).toBeNull();
    expect(parseAgentLine("   ")).toBeNull();
  });

  it("returns null for non-JSON lines (stray stdout)", () => {
    expect(parseAgentLine("Loading model...")).toBeNull();
  });

  it("normalizes an init event", () => {
    const e = parseAgentLine(JSON.stringify({ type: "init", session_id: "s1", model: "gemini-x" }))!;
    expect(e.type).toBe("init");
    expect(e).toMatchObject({ sessionId: "s1", model: "gemini-x" });
  });

  it("extracts text from a message with string content", () => {
    const e = parseAgentLine(JSON.stringify({ type: "message", role: "assistant", content: "Hello" }))!;
    expect(e).toMatchObject({ type: "message", role: "assistant", text: "Hello" });
  });

  it("extracts text from a message with array-of-parts content", () => {
    const e = parseAgentLine(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }] }))!;
    expect(e).toMatchObject({ type: "message", text: "Hi there" });
  });

  it("normalizes a tool_use event (tool_name alias)", () => {
    const e = parseAgentLine(JSON.stringify({ type: "tool_use", tool_name: "write_file", tool_id: "t1" }))!;
    expect(e).toMatchObject({ type: "tool_use", toolName: "write_file", toolId: "t1" });
  });

  it("normalizes a tool_result event", () => {
    const e = parseAgentLine(JSON.stringify({ type: "tool_result", tool_id: "t1", status: "success" }))!;
    expect(e).toMatchObject({ type: "tool_result", toolId: "t1", status: "success" });
  });

  it("normalizes an error event", () => {
    const e = parseAgentLine(JSON.stringify({ type: "error", message: "rate limited" }))!;
    expect(e).toMatchObject({ type: "error", message: "rate limited" });
  });

  it("passes a result event through", () => {
    const e = parseAgentLine(JSON.stringify({ type: "result", stats: { tokens: 10 } }))!;
    expect(e.type).toBe("result");
  });

  it("labels unknown event types as 'unknown' but keeps raw", () => {
    const e = parseAgentLine(JSON.stringify({ type: "weird", foo: 1 }))!;
    expect(e.type).toBe("unknown");
    expect((e as Extract<AgentEvent, { type: "unknown" }>).raw).toMatchObject({ type: "weird", foo: 1 });
  });
});
