import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

// One person holds the server at a time: their GitHub identity backs every
// action, so nobody else can sign in until they sign out or go idle.
const config: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  guardrails: { allow: ["src/**"] },
  setup: { completed: true },
  session: { idleMinutes: 30 },
};

function harness() {
  let clock = 1_000_000;
  let nextUser = { login: "alice", id: 1 };
  const app = createServer(config, {
    exchangeCodeForToken: async () => `tok-${nextUser.login}`,
    fetchGithubUser: async () => ({ ...nextUser, name: nextUser.login, email: `${nextUser.login}@example.com` }),
    sessionStore: makeSessionStore("/dev/null", { read: () => null, write: () => {} }),
    now: () => clock,
  });
  async function signIn(login: string, id: number) {
    nextUser = { login, id };
    const start = await request(app).get("/tweaklet/auth/login").expect(302);
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const stateCookie = ([] as string[]).concat(start.headers["set-cookie"] as any).find((c) => c.startsWith("apz_oauth_state="))!.split(";")[0];
    const res = await request(app).get(`/tweaklet/auth/callback?code=c&state=${state}`).set("Cookie", stateCookie);
    const session = ([] as string[]).concat((res.headers["set-cookie"] as any) ?? []).find((c) => c.startsWith("apz_session=") && !c.startsWith("apz_session=;"));
    return { res, cookie: session?.split(";")[0] };
  }
  const me = (cookie: string) => request(app).get("/tweaklet/agent/me").set("Cookie", cookie);
  return { app, signIn, me, advance: (ms: number) => { clock += ms; } };
}

describe("single active user", () => {
  it("refuses a second person while someone holds the server, and says who and until when", async () => {
    const h = harness();
    const a = await h.signIn("alice", 1);
    expect(a.res.status).toBe(200);
    const b = await h.signIn("bob", 2);
    expect(b.res.status).toBe(423);
    expect(b.cookie).toBeUndefined();
    expect(b.res.text).toContain("@alice");
    expect(b.res.text).toContain("tweaklet:sign-in-failed");
  });

  it("lets the same person sign in again (another browser) while they hold it", async () => {
    const h = harness();
    await h.signIn("alice", 1);
    expect((await h.signIn("alice", 1)).res.status).toBe(200);
  });

  it("frees the server when the holder signs out", async () => {
    const h = harness();
    const a = await h.signIn("alice", 1);
    await request(h.app).post("/tweaklet/auth/logout").set("Cookie", a.cookie!).expect(204);
    expect((await h.signIn("bob", 2)).res.status).toBe(200);
  });

  it("frees the server after the idle timeout, and the idle holder's session ends", async () => {
    const h = harness();
    const a = await h.signIn("alice", 1);
    h.advance(29 * 60_000);
    await h.me(a.cookie!).expect(200); // activity keeps the hold
    h.advance(29 * 60_000);
    expect((await h.signIn("bob", 2)).res.status).toBe(423);
    h.advance(31 * 60_000);
    const b = await h.signIn("bob", 2);
    expect(b.res.status).toBe(200);
    await h.me(a.cookie!).expect(401); // alice's session no longer counts
    await h.me(b.cookie!).expect(200);
  });

  it("idling out ends the holder's session even when nobody else is waiting", async () => {
    const h = harness();
    const a = await h.signIn("alice", 1);
    h.advance(31 * 60_000);
    await h.me(a.cookie!).expect(401);
    expect((await h.signIn("alice", 1)).res.status).toBe(200); // a fresh sign-in takes it again
  });

  it("GET /auth/status tells the sign-in screen the server is busy without naming anyone", async () => {
    const h = harness();
    expect((await request(h.app).get("/tweaklet/auth/status").expect(200)).body).toMatchObject({ inUse: false });
    await h.signIn("alice", 1);
    const busy = (await request(h.app).get("/tweaklet/auth/status").expect(200)).body;
    expect(busy).toMatchObject({ inUse: true, idleMinutes: 30 });
    expect(typeof busy.freeInMinutes).toBe("number");
    expect(JSON.stringify(busy)).not.toContain("alice");
  });
});
