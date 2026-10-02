import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

// Who may sign in follows GitHub: write access to the configured repository.
const base: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  repo: { path: "", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["acme/webapp"] },
  guardrails: { allow: ["src/**"] },
  setup: { completed: true },
};

function harness(config: TweakletConfig, access: (a: any) => Promise<boolean>, extra: Record<string, unknown> = {}) {
  let clock = 1_000_000;
  const app = createServer(config, {
    exchangeCodeForToken: async () => "tok-alice",
    fetchGithubUser: async () => ({ login: "alice", id: 1, name: "Alice", email: "alice@example.com" }),
    checkRepoAccess: access,
    sessionStore: makeSessionStore("/dev/null", { read: () => null, write: () => {} }),
    now: () => clock,
    ...extra,
  } as any);
  async function signIn() {
    const start = await request(app).get("/tweaklet/auth/login").expect(302);
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const sc = ([] as string[]).concat(start.headers["set-cookie"] as any).find((c) => c.startsWith("apz_oauth_state="))!.split(";")[0];
    const res = await request(app).get(`/tweaklet/auth/callback?code=c&state=${state}`).set("Cookie", sc);
    const cookie = ([] as string[]).concat((res.headers["set-cookie"] as any) ?? []).find((c) => c.startsWith("apz_session=") && !c.startsWith("apz_session=;"))?.split(";")[0];
    return { res, cookie };
  }
  return { app, signIn, advance: (ms: number) => { clock += ms; } };
}

describe("repository-based access", () => {
  it("lets in someone with write access, checked with their own token against the allowlisted repo", async () => {
    const access = vi.fn(async () => true);
    const { res } = await harness(base, access).signIn();
    expect(res.status).toBe(200);
    expect(access).toHaveBeenCalledWith(expect.objectContaining({ token: "tok-alice", owner: "acme", name: "webapp" }));
  });

  it("refuses someone without write access, saying why", async () => {
    const { res, cookie } = await harness(base, async () => false).signIn();
    expect(res.status).toBe(403);
    expect(cookie).toBeUndefined();
    expect(res.text).toContain("doesn't have write access to acme/webapp");
    expect(res.text).toContain("tweaklet:sign-in-failed");
  });

  it("checks the cloned repository once one is cloned", async () => {
    const access = vi.fn(async () => true);
    const cloned = { ...base, repo: { ...base.repo!, path: "/repo" } };
    await harness(cloned, access, { lifecycle: { repoSlugFromRemote: async () => ({ owner: "acme", name: "shop" }) } }).signIn();
    expect(access).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", name: "shop" }));
  });

  it("refuses everyone when no repository is configured (instead of letting everyone in)", async () => {
    const none = { ...base, repo: { ...base.repo!, allowlist: [] } };
    const { res } = await harness(none, async () => true).signIn();
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/No repository is configured yet/);
  });

  it("an explicit access list narrows it further", async () => {
    const narrowed = { ...base, access: { allowedLogins: ["bob"] } };
    const { res } = await harness(narrowed, async () => true).signIn();
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/isn't on this server's access list/);
  });

  it("drops the holder once GitHub access is removed (re-checked while they hold the server)", async () => {
    let hasAccess = true;
    const h = harness(base, async () => hasAccess);
    const { cookie } = await h.signIn();
    const me = () => request(h.app).get("/tweaklet/agent/me").set("Cookie", cookie!);
    await me().expect(200);
    hasAccess = false; // removed from the repo on GitHub
    h.advance(11 * 60_000);
    await me(); // triggers the background re-check (may already see the result)
    await new Promise((r) => setTimeout(r, 20));
    await me().expect(401);
  });
});
