import { describe, it, expect, vi } from "vitest";
import { messagesToEvents, fetchSessionMessages } from "./history.js";

describe("messagesToEvents", () => {
  it("maps user/assistant text parts to message events and tool parts to tool_use", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "add hello world" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Done." },
          { type: "tool", tool: "edit", state: { input: { file: "a.tsx" } } },
        ],
      },
    ];
    const ev = messagesToEvents(msgs);
    expect(ev[0]).toMatchObject({ type: "message", role: "user", text: "add hello world" });
    expect(ev[1]).toMatchObject({ type: "message", role: "assistant", text: "Done." });
    expect(ev[2]).toMatchObject({ type: "tool_use", toolName: "edit" });
  });

  it("is lenient: empty/odd input yields [] and skips unknown parts", () => {
    expect(messagesToEvents([])).toEqual([]);
    expect(messagesToEvents(null as any)).toEqual([]);
    expect(
      messagesToEvents([{ info: { role: "assistant" }, parts: [{ type: "mystery" }] }]),
    ).toEqual([]);
  });

  it("skips empty text parts (no blank message rows)", () => {
    expect(
      messagesToEvents([{ info: { role: "assistant" }, parts: [{ type: "text", text: "" }] }]),
    ).toEqual([]);
  });
});

describe("fetchSessionMessages", () => {
  it("returns [] when the client throws", async () => {
    const client = {
      session: {
        messages: vi.fn(async () => {
          throw new Error("down");
        }),
      },
    };
    expect(await fetchSessionMessages(client, "ses_1")).toEqual([]);
  });

  it("unwraps the SDK result (data or array)", async () => {
    const arr = [{ info: { role: "user" }, parts: [] }];
    const client = { session: { messages: vi.fn(async () => ({ data: arr })) } };
    expect(await fetchSessionMessages(client, "ses_1")).toEqual(arr);
  });
});
