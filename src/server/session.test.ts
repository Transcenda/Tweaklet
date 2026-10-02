import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, issueSessionToken } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

const secret = "z".repeat(32);
const config: TweakletConfig = {
  server: { port: 4319, publicUrl: "https://app.example.com", sessionSecret: secret, basePath: "/tweaklet" },
  guardrails: { allow: ["src/**"] },
  setup: { completed: true },
};
const store = () => makeSessionStore("/dev/null", { read: () => null, write: () => {} });
const app = (c: TweakletConfig = config) =>
  createServer(c, { sessionStore: store(), ghCliUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "a@example.com" }) });
const me = (a: ReturnType<typeof app>, cookie: string) => request(a).get("/tweaklet/agent/me").set("Cookie", `apz_session=${cookie}`);
const alice = { login: "alice", id: 7 };

describe("sessions", () => {
  it("accepts a freshly issued session", async () => {
    const res = await me(app(), issueSessionToken(alice, secret)).expect(200);
    expect(res.body.login).toBe("alice");
  });

  it("rejects an expired session", async () => {
    const twoDaysAgo = Date.now() - 48 * 3600 * 1000;
    await me(app(), issueSessionToken(alice, secret, twoDaysAgo)).expect(401);
  });

  it("rejects a signed payload that isn't a session (e.g. a replayed OAuth state cookie)", async () => {
    await me(app(), sign({ typ: "oauth-state", state: "abc", exp: Date.now() + 60_000 }, secret)).expect(401);
    await me(app(), sign({ state: "abc" }, secret)).expect(401);
  });

  it("rejects old-style untagged sessions and malformed claims", async () => {
    await me(app(), sign(alice, secret)).expect(401);
    await me(app(), sign({ typ: "session", sid: "x", login: "alice", id: "7", exp: Date.now() + 60_000 }, secret)).expect(401);
  });

  it("logout revokes the session server-side, not just the browser cookie", async () => {
    const a = app();
    const cookie = issueSessionToken(alice, secret);
    await me(a, cookie).expect(200);
    await request(a).post("/tweaklet/auth/logout").set("Cookie", `apz_session=${cookie}`).expect(204);
    await me(a, cookie).expect(401);
  });

  it("re-checks the access allowlist on every request", async () => {
    const c: TweakletConfig = { ...config, access: { allowedLogins: ["alice"] } };
    const a = app(c);
    const cookie = issueSessionToken(alice, secret);
    await me(a, cookie).expect(200);
    c.access = { allowedLogins: ["bob"] }; // alice removed while signed in
    await me(a, cookie).expect(401);
  });

  it("sets a scoped, expiring, Secure cookie (https publicUrl) and clears the legacy root cookie", async () => {
    const local: TweakletConfig = { ...config, server: { ...config.server, publicUrl: "http://localhost:4319" } };
    const res = await request(app(local)).get("/tweaklet/auth/cli").expect(302);
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] as any);
    const session = cookies.find((c) => c.startsWith("apz_session=") && !c.startsWith("apz_session=;"))!;
    expect(session).toMatch(/Path=\/tweaklet/);
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Max-Age=\d+/);
    expect(session).not.toMatch(/Secure/); // http publicUrl
    expect(cookies.some((c) => c.startsWith("apz_session=;") && /Path=\/;/.test(c + ";"))).toBe(true);
  });

  it("marks the cookie Secure when the public URL is https", async () => {
    const cli = await request(app()).get("/tweaklet/auth/cli").expect(302);
    const cookies = ([] as string[]).concat(cli.headers["set-cookie"] as any);
    expect(cookies.find((c) => c.startsWith("apz_session=") && !c.startsWith("apz_session=;"))).toMatch(/Secure/);
  });
});
