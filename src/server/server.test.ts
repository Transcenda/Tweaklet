import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";
import type { Check } from "../doctor/doctor.js";
import { makeSessionStore } from "./session-store.js";

/** No-op session store — prevents disk writes to ~/.tweaklet during tests. */
function noopStore() { return makeSessionStore("/dev/null", { read: () => null, write: () => {} }); }

const config: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  guardrails: { allow: ["frontend/src/**"] },
  setup: { completed: false },
};

const configNoGithub: TweakletConfig = {
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  guardrails: { allow: ["frontend/src/**"] },
  setup: { completed: false },
};

function appWith(overrides = {}) {
  return createServer(config, {
    exchangeCodeForToken: async () => "gho_tok",
    fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
    sessionStore: noopStore(),
    ...overrides,
  });
}

describe("server", () => {
  it("GET /tweaklet/agent/doctor returns 401 without session", async () => {
    await request(appWith()).get("/tweaklet/agent/doctor").expect(401);
  });

  it("GET /tweaklet/agent/doctor returns checks when authenticated", async () => {
    const sampleCheck: Check[] = [{ name: "opencode", status: "ok", detail: "v1" }];
    const app = createServer(config, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
      runDiagnostics: async () => sampleCheck,
      sessionStore: noopStore(),
    });
    const cookie = `apz_session=${sign({ login: "alice", id: 7 }, config.server.sessionSecret)}`;
    const res = await request(app).get("/tweaklet/agent/doctor").set("Cookie", cookie).expect(200);
    expect(res.body.checks[0].name).toBe("opencode");
    expect(res.body.checks[0].status).toBe("ok");
  });

  it("401s /tweaklet/agent/me without a session", async () => {
    await request(appWith()).get("/tweaklet/agent/me").expect(401);
  });

  it("returns the user on /tweaklet/agent/me with a valid session cookie", async () => {
    const cookie = `apz_session=${sign({ login: "alice", id: 7 }, config.server.sessionSecret)}`;
    const res = await request(appWith()).get("/tweaklet/agent/me").set("Cookie", cookie).expect(200);
    expect(res.body).toEqual({ login: "alice", id: 7 });
  });

  it("/tweaklet/auth/login redirects to GitHub with a state cookie", async () => {
    const res = await request(appWith()).get("/tweaklet/auth/login").expect(302);
    expect(res.headers.location).toContain("https://github.com/login/oauth/authorize");
    expect((res.headers["set-cookie"] as unknown as string[]).join(";")).toContain("apz_oauth_state=");
  });

  it("/tweaklet/auth/callback exchanges code, sets session cookie, and returns popup-close HTML", async () => {
    const agent = request.agent(appWith());
    const login = await agent.get("/tweaklet/auth/login").expect(302);
    const state = new URL(login.headers.location).searchParams.get("state")!;
    const res = await agent.get(`/tweaklet/auth/callback?code=abc&state=${state}`).expect(200);
    expect(res.type).toMatch(/html/);
    // Sets the session cookie so the browser is authenticated after the popup closes.
    expect((res.headers["set-cookie"] as unknown as string[]).join(";")).toContain("apz_session=");
    // The response HTML must contain the postMessage call and window.close() for popup flow.
    expect(res.text).toContain("tweaklet:signed-in");
    expect(res.text).toContain("window.close()");
    // Falls back to a redirect for non-popup direct visits.
    expect(res.text).toContain("/tweaklet/");
  });

  it("/tweaklet/auth/callback rejects a mismatched state", async () => {
    await request(appWith()).get("/tweaklet/auth/callback?code=abc&state=forged").expect(400);
  });

  it("/tweaklet/auth/cli mints a session and redirects to /tweaklet/ when gh CLI is authenticated", async () => {
    const app = createServer(config, { ghCliUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }), sessionStore: noopStore() });
    const res = await request(app).get("/tweaklet/auth/cli").expect(302);
    expect(res.headers.location).toBe("/tweaklet/");
    expect((res.headers["set-cookie"] as unknown as string[]).join(";")).toContain("apz_session=");
  });

  it("/tweaklet/auth/cli returns 400 when gh CLI is not authenticated and no github config", async () => {
    const app = createServer(configNoGithub, { ghCliUser: async () => null, sessionStore: noopStore() });
    const res = await request(app).get("/tweaklet/auth/cli").expect(400);
    expect(res.body.error).toMatch(/gh CLI is not authenticated/i);
  });

  // --- allowlist tests ---

  it("/tweaklet/auth/callback 403s when the resolved user is not on the allowlist", async () => {
    const allowlistConfig: TweakletConfig = {
      ...config,
      access: { allowedLogins: ["bob"] },
    };
    const app = createServer(allowlistConfig, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
      sessionStore: noopStore(),
    });
    const agent = request.agent(app);
    const login = await agent.get("/tweaklet/auth/login").expect(302);
    const state = new URL(login.headers.location).searchParams.get("state")!;
    const res = await agent.get(`/tweaklet/auth/callback?code=abc&state=${state}`).expect(403);
    expect(res.body.error).toBe("not authorized");
    expect(res.body.detail).toContain("alice");
  });

  it("/tweaklet/auth/callback succeeds when the user IS on the allowlist", async () => {
    const allowlistConfig: TweakletConfig = {
      ...config,
      access: { allowedLogins: ["alice"] },
    };
    const app = createServer(allowlistConfig, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
      sessionStore: noopStore(),
    });
    const agent = request.agent(app);
    const login = await agent.get("/tweaklet/auth/login").expect(302);
    const state = new URL(login.headers.location).searchParams.get("state")!;
    const res = await agent.get(`/tweaklet/auth/callback?code=abc&state=${state}`).expect(200);
    expect(res.type).toMatch(/html/);
    expect((res.headers["set-cookie"] as unknown as string[]).join(";")).toContain("apz_session=");
    expect(res.text).toContain("tweaklet:signed-in");
  });

  it("/tweaklet/auth/cli 403s when the gh CLI user is not on the allowlist", async () => {
    const allowlistConfig: TweakletConfig = {
      ...config,
      access: { allowedLogins: ["bob"] },
    };
    const app = createServer(allowlistConfig, { ghCliUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }), sessionStore: noopStore() });
    const res = await request(app).get("/tweaklet/auth/cli").expect(403);
    expect(res.body.error).toBe("not authorized");
    expect(res.body.detail).toContain("alice");
  });
});

describe("basePath routing", () => {
  it("routes are mounted under the configured basePath", async () => {
    const cfgWithBase: TweakletConfig = {
      ...config,
      server: { ...config.server, basePath: "/tw" },
    };
    const app = createServer(cfgWithBase, {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
      sessionStore: noopStore(),
    });
    await request(app).get("/tw/agent/state").expect(401); // mounted under /tw, auth-gated → 401 not 404
    await request(app).get("/agent/state").expect(404);  // NOT at root
  });

  it("widget.js is served under basePath", async () => {
    const cfgWithBase: TweakletConfig = {
      ...config,
      server: { ...config.server, basePath: "/tw" },
    };
    const app = createServer(cfgWithBase, { sessionStore: noopStore() });
    await request(app).get("/tw/widget.js").expect(200);
    await request(app).get("/widget.js").expect(404);
  });

  it("OAuth redirectUri uses publicUrl + basePath", async () => {
    const cfgWithBase: TweakletConfig = {
      ...config,
      server: { ...config.server, basePath: "/tw", publicUrl: "https://example.com" },
    };
    let capturedRedirectUri = "";
    const app = createServer(cfgWithBase, {
      exchangeCodeForToken: async (opts: any) => { capturedRedirectUri = opts.redirectUri; return "gho_tok"; },
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
      sessionStore: noopStore(),
    });
    const agent = request.agent(app);
    const login = await agent.get("/tw/auth/login").expect(302);
    const state = new URL(login.headers.location).searchParams.get("state")!;
    await agent.get(`/tw/auth/callback?code=abc&state=${state}`).expect(200);
    expect(capturedRedirectUri).toBe("https://example.com/tw/auth/callback");
  });
});
