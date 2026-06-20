import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

/** No-op session store — prevents disk writes to ~/.tweaklet during tests. */
function noopStore() { return makeSessionStore("/dev/null", { read: () => null, write: () => {} }); }

const base: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  agent: { command: "opencode", cwd: "/tmp/app", model: "google-vertex-ai/gemini-2.5-flash", vertexProject: "proj-1", vertexLocation: "global" },
  guardrails: { allow: ["frontend/src/**"] },
  setup: { completed: false },
};
const authCookie = `apz_session=${sign({ login: "alice", id: 7 }, base.server.sessionSecret)}`;
// A second authenticated user (bob) — used to test cross-user IDOR prevention.
const bobCookie = `apz_session=${sign({ login: "bob", id: 8 }, base.server.sessionSecret)}`;

// A runPrompt double that just emits an end-ish event and returns a session id.
const fakeRunPrompt = async (a: any) => {
  a.onEvent({ type: "message", role: "assistant", text: "done", raw: {} });
  return { sessionId: "s1", blocked: [] };
};
const fakeGetClient = async () => ({});

function appWith(deps: Record<string, unknown> = {}, config: TweakletConfig = base) {
  return createServer(config, {
    exchangeCodeForToken: async () => "tok",
    fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
    runPrompt: fakeRunPrompt,
    getClient: fakeGetClient,
    sessionStore: noopStore(),
    ...deps,
  });
}

describe("POST /tweaklet/agent/prompt", () => {
  it("401s without a session", async () => {
    await request(appWith()).post("/tweaklet/agent/prompt").send({ prompt: "x" }).expect(401);
  });

  it("400s when no agent is configured", async () => {
    const noAgent = { ...base, agent: undefined };
    await request(appWith({}, noAgent)).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "x" }).expect(400);
  });

  it("400s on an empty prompt", async () => {
    await request(appWith()).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "  " }).expect(400);
  });

  it("400s when no agent model configured", async () => {
    const noModel: TweakletConfig = { ...base, agent: { command: "opencode", cwd: "/tmp/app" } };
    await request(appWith({}, noModel)).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "x" }).expect(400);
  });

  it("streams SSE frames and a terminal end frame", async () => {
    const res = await request(appWith())
      .post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "make it bigger" })
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"text":"done"');
    expect(res.text).toContain('"type":"end","code":0');
  });

  it("drives runPrompt with allow + callbacks (single unified agent)", async () => {
    let captured: any = null;
    const spy = async (a: any) => { captured = a; return { sessionId: "s1", blocked: [] }; };
    await request(appWith({ runPrompt: spy })).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "hello" }).expect(200);
    expect(captured.model).toBe("google-vertex-ai/gemini-2.5-flash");
    expect(captured.prompt).toBe("hello");
    expect(captured.allow).toEqual(["frontend/src/**"]);
    expect(captured.onEvent).toBeTypeOf("function");
    expect(captured.onAsk).toBeTypeOf("function");
    expect(captured.mode).toBeUndefined(); // mode was removed when Explore/Build fused
  });

  it("emits a guardrail frame when runPrompt reports blocked paths", async () => {
    const spy = async () => ({ sessionId: "s1", blocked: ["backend/x.rs"] });
    const res = await request(appWith({ runPrompt: spy })).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "hi" }).expect(200);
    expect(res.text).toContain('"type":"guardrail"');
    expect(res.text).toContain("backend/x.rs");
  });

  it("reuses the session id across prompts (session memory)", async () => {
    const seen: (string | undefined)[] = [];
    const spy = async (a: any) => { seen.push(a.sessionId); return { sessionId: "sess-A", blocked: [] }; };
    const app = appWith({ runPrompt: spy });
    await request(app).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "one" }).expect(200);
    await request(app).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "two" }).expect(200);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("sess-A");
  });

  it("emits an error + end frame when runPrompt throws", async () => {
    const spy = async () => { throw new Error("boom"); };
    const res = await request(appWith({ runPrompt: spy })).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "hi" }).expect(200);
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain("boom");
    expect(res.text).toContain('"type":"end","code":-1');
  });
});

describe("GET /tweaklet/agent/history", () => {
  it("returns mapped events for the holder's session", async () => {
    const app = appWith({
      sessionStore: makeSessionStore("/tmp/x", { read: () => JSON.stringify({ alice: "ses_h" }), write: () => {} }),
      fetchSessionMessages: async () => [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
    });
    const res = await request(app).get("/tweaklet/agent/history").set("Cookie", authCookie).expect(200);
    expect(res.body.sessionId).toBe("ses_h");
    expect(res.body.events[0]).toMatchObject({ type: "message", role: "user", text: "hi" });
  });

  it("returns {events:[]} when the holder has no session", async () => {
    const app = appWith({
      sessionStore: noopStore(),
      fetchSessionMessages: async () => [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
    });
    const res = await request(app).get("/tweaklet/agent/history").set("Cookie", authCookie).expect(200);
    expect(res.body.events).toEqual([]);
  });

  it("401s without a session", async () => {
    await request(appWith()).get("/tweaklet/agent/history").expect(401);
  });

  it("best-effort: returns {events:[]} when fetch throws", async () => {
    const app = appWith({
      sessionStore: makeSessionStore("/tmp/x", { read: () => JSON.stringify({ alice: "ses_h" }), write: () => {} }),
      fetchSessionMessages: async () => { throw new Error("opencode down"); },
    });
    const res = await request(app).get("/tweaklet/agent/history").set("Cookie", authCookie).expect(200);
    expect(res.body.events).toEqual([]);
  });
});

describe("POST /tweaklet/agent/permission", () => {
  it("emits a permission_ask SSE frame, then resolves the pending ask on approve (202)", async () => {
    // runPrompt that calls onAsk and waits for the resolution before finishing.
    let askResult: "approve" | "deny" | null = null;
    const spy = async (a: any) => {
      askResult = await a.onAsk({ permissionID: "per_x", permission: "edit", patterns: ["frontend/src/x.tsx"] });
      return { sessionId: "s1", blocked: [] };
    };
    const app = appWith({ runPrompt: spy });
    // Fire the prompt without awaiting; capture the deferred response.
    const promptDone = request(app).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "hi" }).then((r) => r);
    // Give the handler a tick to register the pending ask + emit the SSE frame.
    await new Promise((r) => setTimeout(r, 50));
    await request(app).post("/tweaklet/agent/permission").set("Cookie", authCookie).send({ permissionID: "per_x", response: "approve" }).expect(202);
    const res = await promptDone;
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"permission_ask"');
    expect(res.text).toContain("per_x");
    expect(askResult).toBe("approve");
  });

  it("404s for an unknown permission id", async () => {
    await request(appWith()).post("/tweaklet/agent/permission").set("Cookie", authCookie).send({ permissionID: "nope", response: "approve" }).expect(404);
  });

  it("401s without a session", async () => {
    await request(appWith()).post("/tweaklet/agent/permission").send({ permissionID: "x", response: "approve" }).expect(401);
  });

  it("404s (IDOR guard) when a different user tries to resolve another user's pending ask", async () => {
    // alice owns the ask; bob must NOT be able to resolve it.
    let askResult: "approve" | "deny" | null = null;
    const spy = async (a: any) => {
      askResult = await a.onAsk({ permissionID: "per_idor", permission: "edit", patterns: ["frontend/src/y.tsx"] });
      return { sessionId: "s1", blocked: [] };
    };
    const app = appWith({ runPrompt: spy });
    // alice fires a prompt — the ask is registered with owner = "alice".
    const promptDone = request(app).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "hi" }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    // bob attempts to resolve alice's ask → must get 404, not 202.
    await request(app).post("/tweaklet/agent/permission").set("Cookie", bobCookie).send({ permissionID: "per_idor", response: "approve" }).expect(404);
    // The ask must still be pending (askResult still null after bob's 404).
    expect(askResult).toBeNull();
    // alice resolves her own ask → 202.
    await request(app).post("/tweaklet/agent/permission").set("Cookie", authCookie).send({ permissionID: "per_idor", response: "approve" }).expect(202);
    await promptDone;
    expect(askResult).toBe("approve");
  });
});

describe("POST /tweaklet/agent/dom-result", () => {
  it("404s for an unknown requestId (no pending round-trip)", async () => {
    await request(appWith())
      .post("/tweaklet/agent/dom-result")
      .set("Cookie", authCookie)
      .send({ requestId: "dom_nope", result: { exists: false } })
      .expect(404, { ok: false });
  });

  it("400s when requestId or result is missing/malformed", async () => {
    await request(appWith())
      .post("/tweaklet/agent/dom-result")
      .set("Cookie", authCookie)
      .send({ requestId: "dom_1" })
      .expect(400);
  });

  it("401s without a session", async () => {
    await request(appWith())
      .post("/tweaklet/agent/dom-result")
      .send({ requestId: "dom_1", result: { exists: false } })
      .expect(401);
  });
});

describe("POST /tweaklet/agent/stop", () => {
  it("409s when no run is in progress", async () => {
    await request(appWith()).post("/tweaklet/agent/stop").set("Cookie", authCookie).expect(409);
  });

  it("202s and aborts a run in progress", async () => {
    const spy = (a: any) =>
      new Promise<{ sessionId: string; blocked: string[] }>((res) => {
        a.signal?.addEventListener("abort", () => res({ sessionId: "s1", blocked: [] }));
      });
    const app = appWith({ runPrompt: spy });
    const promptDone = request(app).post("/tweaklet/agent/prompt").set("Cookie", authCookie).send({ prompt: "hello" }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    await request(app).post("/tweaklet/agent/stop").set("Cookie", authCookie).expect(202);
    const res = await promptDone;
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /tweaklet/agent/clone
// ---------------------------------------------------------------------------

const configWithRepoAllowlist: TweakletConfig = {
  ...base,
  repo: { path: "", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["transcenda/t8a"], sourceDir: "/tmp/repos" },
  setup: { completed: false },
};

/**
 * Drive the real OAuth callback so the tokenStore is populated.
 * Returns the apz_session cookie string (key=value only).
 */
async function signInAlice(app: any): Promise<string> {
  // GET /auth/login sets the signed apz_oauth_state cookie and redirects.
  // The Location header contains the GitHub authorize URL with state=<plaintext>.
  const login = await request(app).get("/tweaklet/auth/login");
  const loc = new URL(login.headers.location as string);
  const state = loc.searchParams.get("state")!;
  const loginCookies: string[] = [].concat(login.headers["set-cookie"] as any);
  const stateCookie = loginCookies.find((c: string) => c.startsWith("apz_oauth_state="))!.split(";")[0];
  // Call the callback with the matching state — injected deps make the exchange deterministic.
  const cb = await request(app)
    .get(`/tweaklet/auth/callback?code=c&state=${state}`)
    .set("Cookie", stateCookie);
  const cbCookies: string[] = [].concat(cb.headers["set-cookie"] as any);
  return cbCookies.find((c: string) => c.startsWith("apz_session="))!.split(";")[0];
}

describe("GET /tweaklet/agent/repos", () => {
  it("returns allowlist and cloned status (authed)", async () => {
    const app = createServer(configWithRepoAllowlist, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "a@x.com" }),
      sessionStore: noopStore(),
    });
    const session = await signInAlice(app);
    const res = await request(app)
      .get("/tweaklet/agent/repos")
      .set("Cookie", session)
      .expect(200);
    expect(res.body.allowlist).toEqual(["transcenda/t8a"]);
    expect(typeof res.body.cloned).toBe("boolean");
  });

  it("returns 401 without a session", async () => {
    await request(appWith()).get("/tweaklet/agent/repos").expect(401);
  });
});

describe("POST /tweaklet/agent/clone", () => {
  it("clones the selected allowlisted repo with the user's token", async () => {
    let cloned: { repoRef: string; token: string } | null = null;
    const app = createServer(configWithRepoAllowlist, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "a@x.com" }),
      cloneRepo: async (repoRef: string, opts: any) => {
        cloned = { repoRef, token: opts.token };
        return "/tmp/src/t8a";
      },
      saveConfig: () => {},
      sessionStore: noopStore(),
    });
    const session = await signInAlice(app);
    const res = await request(app)
      .post("/tweaklet/agent/clone")
      .set("Cookie", session)
      .send({ repoRef: "transcenda/t8a" })
      .expect(200);
    expect(cloned!.repoRef).toBe("transcenda/t8a");
    expect(cloned!.token).toBe("gho_tok");
    expect(res.body.path).toBe("/tmp/src/t8a");
  });

  it("returns 400 when no repo is configured", async () => {
    const noRepo = { ...base, repo: undefined };
    const app = createServer(noRepo, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "a@x.com" }),
      saveConfig: () => {},
      sessionStore: noopStore(),
    });
    const session = await signInAlice(app);
    await request(app).post("/tweaklet/agent/clone").set("Cookie", session).send({ repoRef: "transcenda/t8a" }).expect(400);
  });

  it("returns 401 without a session", async () => {
    await request(appWith()).post("/tweaklet/agent/clone").send({ repoRef: "transcenda/t8a" }).expect(401);
  });

  it("triggers ensurePreview when preview is configured", async () => {
    const previewConfig = { serviceName: "t8a-frontend-dev", subdir: "frontend", installCheckDir: "frontend/node_modules" };
    const configWithPreview: TweakletConfig = {
      ...configWithRepoAllowlist,
      preview: previewConfig,
    };
    const ensurePreviewSpy = vi.fn(async () => ({ started: true }));
    const app = createServer(configWithPreview, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "a@x.com" }),
      cloneRepo: async () => "/repo",
      saveConfig: () => {},
      ensurePreview: ensurePreviewSpy,
      sessionStore: noopStore(),
    });
    const session = await signInAlice(app);
    const res = await request(app)
      .post("/tweaklet/agent/clone")
      .set("Cookie", session)
      .send({ repoRef: "transcenda/t8a" })
      .expect(200);
    expect(res.body.path).toBe("/repo");
    expect(ensurePreviewSpy).toHaveBeenCalledOnce();
    expect(ensurePreviewSpy).toHaveBeenCalledWith("/repo", previewConfig);
  });

  it("clone still succeeds (200) when ensurePreview throws", async () => {
    const previewConfig = { serviceName: "t8a-frontend-dev", subdir: "frontend", installCheckDir: "frontend/node_modules" };
    const configWithPreview: TweakletConfig = {
      ...configWithRepoAllowlist,
      preview: previewConfig,
    };
    const ensurePreviewSpy = vi.fn(async () => { throw new Error("systemctl failed"); });
    const app = createServer(configWithPreview, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "a@x.com" }),
      cloneRepo: async () => "/repo",
      saveConfig: () => {},
      ensurePreview: ensurePreviewSpy,
      sessionStore: noopStore(),
    });
    const session = await signInAlice(app);
    const res = await request(app)
      .post("/tweaklet/agent/clone")
      .set("Cookie", session)
      .send({ repoRef: "transcenda/t8a" })
      .expect(200);
    expect(res.body.path).toBe("/repo");
    expect(ensurePreviewSpy).toHaveBeenCalledOnce();
  });
});
