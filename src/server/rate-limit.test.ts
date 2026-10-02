import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, issueSessionToken } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

const config: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  guardrails: { allow: ["src/**"] },
  setup: { completed: true },
};
const cookieFor = (login: string, id: number) => `apz_session=${issueSessionToken({ login, id }, config.server.sessionSecret)}`;
const app = (rateLimit: { api?: number; auth?: number }) =>
  createServer(config, { sessionStore: makeSessionStore("/dev/null", { read: () => null, write: () => {} }), rateLimit });

describe("rate limiting", () => {
  it("limits API calls per signed-in user, not per IP (everyone shares 127.0.0.1 behind a proxy)", async () => {
    const a = app({ api: 3 });
    for (let i = 0; i < 3; i++) await request(a).get("/tweaklet/agent/me").set("Cookie", cookieFor("alice", 1)).expect(200);
    const limited = await request(a).get("/tweaklet/agent/me").set("Cookie", cookieFor("alice", 1)).expect(429);
    expect(limited.body.error).toMatch(/too many requests/i);
    // Same IP, different user → a separate budget: bob isn't rate-limited (he's
    // refused only because alice holds the server — one active user at a time).
    await request(a).get("/tweaklet/agent/me").set("Cookie", cookieFor("bob", 2)).expect(401);
  });

  it("limits sign-in attempts per client", async () => {
    const a = app({ auth: 2 });
    await request(a).get("/tweaklet/auth/login").expect(302);
    await request(a).get("/tweaklet/auth/login").expect(302);
    await request(a).get("/tweaklet/auth/login").expect(429);
  });

  it("never limits the widget bundle or the bootstrap page", async () => {
    const a = app({ api: 1, auth: 1 });
    for (let i = 0; i < 5; i++) {
      const res = await request(a).get("/tweaklet/widget.js");
      expect(res.status).not.toBe(429);
    }
  });

  it("sends standard RateLimit headers", async () => {
    const res = await request(app({ api: 10 })).get("/tweaklet/agent/me").set("Cookie", cookieFor("alice", 1)).expect(200);
    expect(res.headers["ratelimit-policy"] ?? res.headers["ratelimit"]).toBeTruthy();
  });
});
