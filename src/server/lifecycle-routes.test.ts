import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

/** No-op session store — prevents disk writes to ~/.tweaklet during tests. */
function noopStore() { return makeSessionStore("/dev/null", { read: () => null, write: () => {} }); }

const config: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  repo: { path: "/repo", baseBranch: "main", branchPrefix: "sandbox/", prTarget: "main", allowlist: [] },
  run: { liveUpdate: "hot-reload" },
  guardrails: { allow: ["frontend/src/**"] },
  setup: { completed: false },
};
const cookie = `apz_session=${sign({ login: "alice", id: 7 }, config.server.sessionSecret)}`;

const lifecycle = {
  startBranch: async (_cwd: string, o: any) => `tweaklet/${o.idea.toLowerCase().replace(/\W+/g, "-")}`,
  syncIntoBranch: async () => ({ status: "up-to-date" as const }),
  currentBranch: async () => "sandbox/alice-bigger",
  checkpoint: async () => {},
  discard: async () => {},
  branchState: async () => ({ branch: "tweaklet/x", base: "main", onFeature: true, commits: [{ sha: "a".repeat(40), message: "first", relativeTime: "1 min ago" }] }),
  isDirty: async () => false,
  previewCommit: async () => {},
  exitPreview: async () => {},
  restoreCommit: async () => {},
  refresh: async () => ({ reloaded: false, ranCommand: null }),
  createDraftPr: async () => "https://github.com/acme/app/pull/9",
  prStatus: async () => ({ state: "OPEN", isDraft: true, url: "u", reviews: [] }),
  repoSlugFromRemote: async () => ({ owner: "acme", name: "app" }),
};

function app(extra = {}) {
  return createServer(config, { exchangeCodeForToken: async () => "t", fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }), lifecycle: { ...lifecycle, ...extra }, sessionStore: noopStore() } as any);
}

/**
 * Drive the real OAuth callback so the tokenStore is populated.
 * Returns the apz_session cookie (key=value only).
 */
async function signInAlice(appInstance: any): Promise<string> {
  const login = await request(appInstance).get("/tweaklet/auth/login");
  const loc = new URL(login.headers.location as string);
  const state = loc.searchParams.get("state")!;
  const loginCookies: string[] = [].concat(login.headers["set-cookie"] as any);
  const stateCookie = loginCookies.find((c) => c.startsWith("apz_oauth_state="))!.split(";")[0];
  const cb = await request(appInstance)
    .get(`/tweaklet/auth/callback?code=c&state=${state}`)
    .set("Cookie", stateCookie);
  const cbCookies: string[] = [].concat(cb.headers["set-cookie"] as any);
  return cbCookies.find((c) => c.startsWith("apz_session="))!.split(";")[0];
}

describe("lifecycle endpoints", () => {
  it("all require auth", async () => {
    for (const [m, p] of [["post", "/tweaklet/agent/idea"], ["post", "/tweaklet/agent/sync"], ["post", "/tweaklet/agent/checkpoint"], ["post", "/tweaklet/agent/undo"], ["post", "/tweaklet/agent/refresh"], ["post", "/tweaklet/agent/pr"], ["get", "/tweaklet/agent/pr"], ["get", "/tweaklet/agent/state"]] as const) {
      await (request(app()) as any)[m](p).expect(401);
    }
  });

  it("POST /tweaklet/agent/idea starts a branch named per convention, passing the user token", async () => {
    let seenToken: string | undefined;
    const a = app({ startBranch: async (_cwd: string, o: any) => { seenToken = o.token; return `tweaklet/${o.idea.toLowerCase().replace(/\W+/g, "-")}`; } });
    const tok = await signInAlice(a); // populates tokenStore via the real OAuth callback
    const res = await request(a).post("/tweaklet/agent/idea").set("Cookie", tok).send({ idea: "Bigger" }).expect(200);
    expect(res.body.branch).toBe("tweaklet/bigger");
    expect(seenToken).toBe("t"); // the exchanged OAuth token (see app() stub)
  });

  it("POST /tweaklet/agent/idea works without a stored token (local/CLI auth), passing an empty token", async () => {
    // Starting a change must not require an OAuth token: syncBase is best-effort,
    // so a signed-in user with no stored token (local/CLI auth) can still tweak.
    let seenToken: string | undefined;
    const a = app({ startBranch: async (_cwd: string, o: any) => { seenToken = o.token; return `tweaklet/${o.idea.toLowerCase().replace(/\W+/g, "-")}`; } });
    const res = await request(a).post("/tweaklet/agent/idea").set("Cookie", cookie).send({ idea: "x" }).expect(200);
    expect(res.body.branch).toBe("tweaklet/x");
    expect(seenToken).toBe("");
  });

  it("POST /tweaklet/agent/sync calls syncIntoBranch with base+token and returns its result", async () => {
    let args: any;
    const a = app({ syncIntoBranch: async (cwd: string, base: string, token: string) => { args = { cwd, base, token }; return { status: "conflict", conflicts: ["src/x.ts"] }; } });
    const tok = await signInAlice(a);
    const res = await request(a).post("/tweaklet/agent/sync").set("Cookie", tok).send().expect(200);
    expect(res.body).toEqual({ status: "conflict", conflicts: ["src/x.ts"] });
    expect(args).toEqual({ cwd: "/repo", base: "main", token: "t" });
  });

  it("POST /tweaklet/agent/sync 401s when the user has no stored token", async () => {
    await request(app()).post("/tweaklet/agent/sync").set("Cookie", cookie).send().expect(401);
  });

  it("POST /tweaklet/agent/sync 400s when no repo is configured", async () => {
    const noRepo = createServer({ ...config, repo: undefined }, { exchangeCodeForToken: async () => "t", fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }), lifecycle, sessionStore: noopStore() } as any);
    const tok = await signInAlice(noRepo);
    await request(noRepo).post("/tweaklet/agent/sync").set("Cookie", tok).send().expect(400);
  });

  it("POST /tweaklet/agent/checkpoint and /tweaklet/agent/undo return 204", async () => {
    const a = app();
    const tok = await signInAlice(a);
    await request(a).post("/tweaklet/agent/checkpoint").set("Cookie", tok).send({ message: "wip" }).expect(204);
    await request(a).post("/tweaklet/agent/undo").set("Cookie", tok).send().expect(204);
  });

  it("POST /tweaklet/agent/refresh returns the refresh result", async () => {
    const res = await request(app()).post("/tweaklet/agent/refresh").set("Cookie", cookie).send().expect(200);
    expect(res.body).toEqual({ reloaded: false, ranCommand: null });
  });

  it("POST /tweaklet/agent/pr opens a draft PR from the current branch", async () => {
    const a = app();
    const tok = await signInAlice(a);
    const res = await request(a).post("/tweaklet/agent/pr").set("Cookie", tok).send({ title: "Bigger box" }).expect(200);
    expect(res.body.url).toContain("/pull/");
  });

  it("GET /tweaklet/agent/pr returns PR status", async () => {
    const a = app();
    const tok = await signInAlice(a);
    const res = await request(a).get("/tweaklet/agent/pr").set("Cookie", tok).expect(200);
    expect(res.body).toMatchObject({ state: "OPEN", isDraft: true });
  });

  it("GET /tweaklet/agent/state returns branch + commits + previewing", async () => {
    const res = await request(app()).get("/tweaklet/agent/state").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ branch: "tweaklet/x", onFeature: true, previewing: null });
    expect(res.body.commits).toHaveLength(1);
  });

  it("POST /tweaklet/agent/preview previews a sha (204) and blocks when dirty (409)", async () => {
    await request(app()).post("/tweaklet/agent/preview").set("Cookie", cookie).send({ sha: "a".repeat(40) }).expect(204);
    await request(app({ isDirty: async () => true })).post("/tweaklet/agent/preview").set("Cookie", cookie).send({ sha: "a".repeat(40) }).expect(409);
  });
  it("POST /tweaklet/agent/preview/exit and /tweaklet/agent/restore return 204", async () => {
    const a = app();
    const tok = await signInAlice(a);
    await request(a).post("/tweaklet/agent/preview/exit").set("Cookie", tok).send().expect(204);
    await request(a).post("/tweaklet/agent/restore").set("Cookie", tok).send({ sha: "a".repeat(40) }).expect(204);
  });

  it("400s when repo is not configured", async () => {
    const noRepo = createServer({ ...config, repo: undefined }, { exchangeCodeForToken: async () => "t", fetchGithubUser: async () => ({ login: "alice", id: 7 }), lifecycle, sessionStore: noopStore() } as any);
    await request(noRepo).post("/tweaklet/agent/idea").set("Cookie", cookie).send({ idea: "x" }).expect(400);
  });
});
