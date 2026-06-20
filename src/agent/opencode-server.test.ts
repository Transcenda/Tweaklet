import { describe, it, expect, vi } from "vitest";
import { runPrompt, smokeTestAgent } from "./opencode-server.js";

function fakeClient() {
  const queue: any[] = []; let wake: (() => void) | null = null;
  const emit = (ev: any) => { queue.push(ev); wake?.(); wake = null; };
  const stream = (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift();
      await new Promise<void>((r) => (wake = r));
    }
  })();
  const calls = { perms: [] as any[], aborts: 0, prompts: [] as any[] };
  const client = {
    session: {
      create: vi.fn(async () => ({ data: { id: "ses_x" } })),
      prompt: vi.fn(async (a: any) => { calls.prompts.push(a); }),
      abort: vi.fn(async () => { calls.aborts++; }),
    },
    event: { subscribe: vi.fn(async () => ({ stream })) },
    postSessionIdPermissionsPermissionId: vi.fn(async (a: any) => { calls.perms.push(a); }),
  };
  return { client, emit, calls };
}
const base = (over: any) => ({ model: "google-vertex-ai/gemini-2.5-flash", prompt: "hi", allow: ["frontend/src/**"], onEvent: () => {}, onAsk: async () => "approve" as const, graceMs: 30, ...over });

describe("runPrompt", () => {
  it("auto-approves an in-bounds edit (once) and creates a session", async () => {
    const { client, emit, calls } = fakeClient();
    const p = runPrompt(base({ client }));
    emit({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_x", permission: "edit", patterns: ["frontend/src/A.tsx"] } });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    const r = await p;
    expect(calls.perms[0].body.response).toBe("once");
    expect(r.sessionId).toBe("ses_x");
  });
  it("auto-denies an out-of-bounds edit (reject) and records blocked", async () => {
    const { client, emit, calls } = fakeClient();
    const p = runPrompt(base({ client }));
    emit({ type: "permission.asked", properties: { id: "per_2", sessionID: "ses_x", permission: "edit", patterns: ["backend/x.rs"] } });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    const r = await p;
    expect(calls.perms[0].body.response).toBe("reject");
    expect(r.blocked).toContain("backend/x.rs");
  });
  it("asks for a bash permission and uses the onAsk result", async () => {
    const { client, emit, calls } = fakeClient();
    const onAsk = vi.fn(async () => "deny" as const);
    const p = runPrompt(base({ client, onAsk }));
    emit({ type: "permission.asked", properties: { id: "per_3", sessionID: "ses_x", permission: "bash", patterns: [] } });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    await p;
    expect(onAsk).toHaveBeenCalled();
    expect(calls.perms[0].body.response).toBe("reject");
  });
  it("forwards non-permission events to onEvent", async () => {
    const { client, emit } = fakeClient();
    const seen: any[] = [];
    const p = runPrompt(base({ client, onEvent: (e: any) => seen.push(e) }));
    emit({ type: "message.part.updated", properties: { sessionID: "ses_x", part: { type: "text", text: "hi" } } });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    await p;
    expect(seen.some((e) => e.type === "message.part.updated")).toBe(true);
  });
  it("aborts via the signal -> calls session.abort", async () => {
    const { client, emit, calls } = fakeClient();
    const ac = new AbortController();
    const p = runPrompt(base({ client, signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    await p;
    expect(calls.aborts).toBeGreaterThan(0);
  });
  it("reuses a provided sessionId (no create)", async () => {
    const { client, emit, calls } = fakeClient();
    const p = runPrompt(base({ client, sessionId: "ses_keep" }));
    emit({ type: "session.idle", properties: { sessionID: "ses_keep" } });
    const r = await p;
    expect(client.session.create).not.toHaveBeenCalled();
    expect(r.sessionId).toBe("ses_keep");
  });
  it("emits an error event when session.prompt rejects (no longer swallowed)", async () => {
    const { client, emit } = fakeClient();
    client.session.prompt = vi.fn(async () => { throw new Error("Agent not found: assistant"); });
    const seen: any[] = [];
    const p = runPrompt(base({ client, onEvent: (e: any) => seen.push(e) }));
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    await p;
    expect(seen.some((e) => e.type === "error" && /Agent not found/.test(e.message))).toBe(true);
  });
});

describe("smokeTestAgent", () => {
  it("returns ok when the agent completes without error", async () => {
    const { client, emit } = fakeClient();
    const p = smokeTestAgent({ client, model: "google-vertex-ai/gemini-2.5-pro" });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    const r = await p;
    expect(r.ok).toBe(true);
  });
  it("returns not-ok with detail when a session.error arrives (Model not found)", async () => {
    const { client, emit } = fakeClient();
    const p = smokeTestAgent({ client, model: "google-vertex-ai/gemini-2.5-pro" });
    emit({ type: "session.error", properties: { sessionID: "ses_x", error: { message: "Model not found" } } });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Model not found");
  });
  it("returns not-ok when the prompt itself rejects", async () => {
    const { client, emit } = fakeClient();
    client.session.prompt = vi.fn(async () => { throw new Error("Agent not found: assistant"); });
    const p = smokeTestAgent({ client, model: "google-vertex-ai/gemini-2.5-pro" });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Agent not found");
  });
});
