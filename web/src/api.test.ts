import { describe, it, expect, vi, afterEach } from "vitest";
import { api, setupApi, streamPrompt, setBase, getBase } from "./api.js";

afterEach(() => {
  vi.restoreAllMocks();
  setBase("");
});

function jsonResp(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

describe("api", () => {
  it("me() returns the user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({ login: "alice", id: 7 })));
    expect(await api.me()).toEqual({ login: "alice", id: 7 });
  });

  it("me() returns null on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({ error: "unauthorized" }, 401)));
    expect(await api.me()).toBeNull();
  });

  it("startIdea posts the idea and returns the branch", async () => {
    const f = vi.fn(async () => jsonResp({ branch: "sandbox/alice-x" }));
    vi.stubGlobal("fetch", f);
    expect(await api.startIdea("make it bigger")).toEqual({ branch: "sandbox/alice-x" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/agent/idea");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ idea: "make it bigger" });
    expect(init.credentials).toBe("include");
  });

  it("createPr posts and returns the url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({ url: "https://gh/pr/9" })));
    expect(await api.createPr("Bigger box")).toEqual({ url: "https://gh/pr/9" });
  });

  it("streamPrompt parses SSE frames into events until end", async () => {
    const frames = [
      'data: {"type":"message","role":"assistant","text":"working"}\n\n',
      'data: {"type":"tool_use","toolName":"write"}\n\n',
      'data: {"type":"end","code":0}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body } as unknown as Response)));
    const got: any[] = [];
    const end = await streamPrompt("hi", (e) => got.push(e));
    expect(got.map((e) => e.type)).toEqual(["message", "tool_use"]);
    expect(end).toEqual({ type: "end", code: 0 });
  });

  it("streamPrompt posts the prompt", async () => {
    const body = new ReadableStream<Uint8Array>({ start(c){ c.enqueue(new TextEncoder().encode('data: {"type":"end","code":0}\n\n')); c.close(); } });
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, body } as unknown as Response));
    vi.stubGlobal("fetch", f);
    await streamPrompt("hi", () => {});
    expect(JSON.parse((f.mock.calls[0][1] as any).body)).toEqual({ prompt: "hi" });
  });

  it("respondPermission posts permissionID + response", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 204 } as Response));
    vi.stubGlobal("fetch", f);
    await api.respondPermission("perm-1", "approve");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/agent/permission");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ permissionID: "perm-1", response: "approve" });
    expect(init.credentials).toBe("include");
  });

  it("stop() posts to /agent/stop", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({}) } as Response));
    vi.stubGlobal("fetch", f);
    await api.stop();
    expect(f.mock.calls[0][0]).toBe("/agent/stop");
  });

  it("streamPrompt reassembles a frame split across two reads", async () => {
    const enc = new TextEncoder();
    const full = 'data: {"type":"message","text":"hello"}\n\n';
    const a = enc.encode(full.slice(0, 15));
    const b = enc.encode(full.slice(15));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(a); c.enqueue(b); c.close(); } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body } as unknown as Response)));
    const got: any[] = [];
    await streamPrompt("x", (e) => got.push(e));
    expect(got).toEqual([{ type: "message", text: "hello" }]);
  });

  it("streamPrompt handles a non-ASCII final frame (decoder flush)", async () => {
    const enc = new TextEncoder();
    // split the multibyte emoji across the two chunks to force a held partial sequence
    const frame = 'data: {"type":"message","text":"🥝"}\n\n';
    const bytes = enc.encode(frame);
    const cut = bytes.length - 4; // mid-emoji-ish tail in the second chunk
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body } as unknown as Response)));
    const got: any[] = [];
    await streamPrompt("x", (e) => got.push(e));
    expect(got).toEqual([{ type: "message", text: "🥝" }]);
  });

  it("streamPrompt skips SSE comment/keepalive lines", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(": keepalive\n\n"));
        c.enqueue(enc.encode('data: {"type":"tool_use","toolName":"read"}\n\n'));
        c.enqueue(enc.encode('data: {"type":"end","code":0}\n\n'));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body } as unknown as Response)));
    const got: any[] = [];
    const end = await streamPrompt("x", (e) => got.push(e));
    expect(got.map((e) => e.type)).toEqual(["tool_use"]);
    expect(end).toEqual({ type: "end", code: 0 });
  });

  it("streamPrompt stops at the end frame and ignores trailing bytes", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"type":"end","code":0}\n\n'));
        c.enqueue(enc.encode('data: {"type":"message","text":"after end"}\n\n'));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body } as unknown as Response)));
    const got: any[] = [];
    const end = await streamPrompt("x", (e) => got.push(e));
    expect(got).toEqual([]); // nothing after end
    expect(end).toEqual({ type: "end", code: 0 });
  });
});

describe("BASE prefix via setBase/getBase", () => {
  it("setBase/getBase round-trips", () => {
    setBase("/tw");
    expect(getBase()).toBe("/tw");
  });

  it("startIdea prefixes with BASE", async () => {
    setBase("/tw");
    const f = vi.fn(async () => jsonResp({ branch: "x" }));
    vi.stubGlobal("fetch", f);
    await api.startIdea("test");
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe("/tw/agent/idea");
  });

  it("stop() prefixes with BASE", async () => {
    setBase("/tw");
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({}) } as Response));
    vi.stubGlobal("fetch", f);
    await api.stop();
    expect(f.mock.calls[0][0]).toBe("/tw/agent/stop");
  });

  it("respondPermission prefixes with BASE", async () => {
    setBase("/tw");
    const f = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 204 } as Response));
    vi.stubGlobal("fetch", f);
    await api.respondPermission("perm-1", "approve");
    expect(f.mock.calls[0][0]).toBe("/tw/agent/permission");
  });

  it("streamPrompt prefixes with BASE", async () => {
    setBase("/tw");
    const body = new ReadableStream<Uint8Array>({ start(c){ c.enqueue(new TextEncoder().encode('data: {"type":"end","code":0}\n\n')); c.close(); } });
    const f = vi.fn(async () => ({ ok: true, status: 200, body } as any));
    vi.stubGlobal("fetch", f);
    await streamPrompt("hi", () => {});
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe("/tw/agent/prompt");
  });
});

describe("api.repos", () => {
  it("GETs /agent/repos", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      ({ ok: true, status: 200, json: async () => ({ allowlist: ["o/r"], cloned: false }) } as Response)
    );
    vi.stubGlobal("fetch", f);
    const result = await api.repos();
    expect(f.mock.calls[0][0]).toBe("/agent/repos");
    expect(result).toEqual({ allowlist: ["o/r"], cloned: false });
  });
});

describe("setupApi.repo allowlist + api.clone", () => {
  it("setupApi.repo posts an allowlist; api.clone posts a repoRef", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ path: "/p", steps: [], checks: [], allowlist: [], firstIncompleteStepId: null, completed: false }), { status: 200 });
    }) as any;
    await setupApi.repo({ allowlist: ["o/r"] });
    await api.clone("o/r");
    expect(calls.find((c) => c.url.endsWith("/setup/repo"))!.body).toEqual({ allowlist: ["o/r"] });
    expect(calls.find((c) => c.url.endsWith("/agent/clone"))!.body).toEqual({ repoRef: "o/r" });
  });
});
