import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, issueSessionToken } from "./server.js";
import { ConfigSchema, type TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

const config: TweakletConfig = {
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  agent: { command: "opencode", cwd: "/repo", model: "google-vertex-ai/gemini-2.5-pro" },
  repo: { path: "/repo", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: [] },
  guardrails: { allow: ["src/**"] },
  setup: { completed: true },
};
const cookie = `apz_session=${issueSessionToken({ login: "alice", id: 1 }, config.server.sessionSecret)}`;
const store = () => makeSessionStore("/dev/null", { read: () => null, write: () => {} });

describe("guardrail globs are validated in the config", () => {
  const parse = (allow: string[]) => ConfigSchema.safeParse({ ...config, guardrails: { allow } }).success;
  it.each([["**"], ["*"], ["**/*"], ["/etc/**"], ["src/../**"], [".git/hooks/*"], ["C:/x/**"]])("refuses %s", (g) => {
    expect(parse([g])).toBe(false);
  });
  it.each([["src/**"], ["frontend/src/**/*.tsx"], ["app/components/**"]])("accepts %s", (g) => {
    expect(parse([g])).toBe(true);
  });
});

describe("setup routes fail closed", () => {
  it("once setup was complete at start, setup routes are gone even if the config file can't be read", async () => {
    const app = createServer(config, { sessionStore: store(), loadConfig: () => { throw new Error("EACCES"); } });
    await request(app).post("/tweaklet/setup/doctor").set("x-tweaklet-setup-token", "anything").expect(410);
  });
});

describe("discarding a change is for its owner", () => {
  const lifecycle = (owner: string | null, done: string[]) => ({
    currentBranch: async () => "tweaklet/bobs-idea",
    branchOwner: async () => owner,
    reject: async () => { done.push("rejected"); },
  }) as any;
  it("refuses to discard someone else's change", async () => {
    const done: string[] = [];
    const app = createServer(config, { sessionStore: store(), lifecycle: lifecycle("bob", done) });
    const res = await request(app).post("/tweaklet/agent/reject").set("Cookie", cookie).expect(403);
    expect(res.body.error).toMatch(/only @bob/);
    expect(done).toEqual([]);
  });
  it("lets the owner (or anyone, for changes from before owners were recorded) discard", async () => {
    const done: string[] = [];
    await request(createServer(config, { sessionStore: store(), lifecycle: lifecycle("alice", done) })).post("/tweaklet/agent/reject").set("Cookie", cookie).expect(204);
    await request(createServer(config, { sessionStore: store(), lifecycle: lifecycle(null, done) })).post("/tweaklet/agent/reject").set("Cookie", cookie).expect(204);
    expect(done).toEqual(["rejected", "rejected"]);
  });
});

describe("restore only completes a preview", () => {
  it("refuses to restore when nothing is being previewed (never onto the base)", async () => {
    let restored = false;
    const app = createServer(config, { sessionStore: store(), lifecycle: { restoreCommit: async () => { restored = true; } } as any });
    const res = await request(app).post("/tweaklet/agent/restore").set("Cookie", cookie).send({ sha: "a".repeat(40) });
    expect([401, 409]).toContain(res.status); // 401 without a GitHub token; 409 with one
    expect(restored).toBe(false);
  });
});

describe("agent runs don't outlive the person", () => {
  it("denies a permission ask nobody answers", async () => {
    let decision: string | null = null;
    const runPrompt = async (a: any) => {
      decision = await a.onAsk({ permissionID: "p1", permission: "bash", patterns: ["make deploy"] });
      return { sessionId: "s", blocked: [] };
    };
    const app = createServer(config, { sessionStore: store(), runPrompt, getClient: async () => ({}), askTimeoutMs: 30, lifecycle: { currentBranch: async () => "tweaklet/x" } as any });
    await request(app).post("/tweaklet/agent/prompt").set("Cookie", cookie).send({ prompt: "x" }).expect(200);
    expect(decision).toBe("deny");
  });

  it("stops the run when the client disconnects", async () => {
    let aborted = false;
    let release: () => void = () => {};
    const runPrompt = async (a: any) => {
      a.signal.addEventListener("abort", () => { aborted = true; release(); });
      await new Promise<void>((r) => { release = r; });
      return { sessionId: "s", blocked: [] };
    };
    const app = createServer(config, { sessionStore: store(), runPrompt, getClient: async () => ({}), lifecycle: { currentBranch: async () => "tweaklet/x" } as any });
    const req = request(app).post("/tweaklet/agent/prompt").set("Cookie", cookie).send({ prompt: "x" });
    setTimeout(() => (req as any).abort(), 80);
    await req.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });
});

describe("a PR only carries what the guardrails allow", () => {
  const prConfig: TweakletConfig = { ...config, github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" }, repo: { ...config.repo!, allowlist: ["acme/webapp"] } };
  async function signedIn(changed: string[], pushed: string[]) {
    const app = createServer(prConfig, {
      sessionStore: store(),
      exchangeCodeForToken: async () => "tok",
      fetchGithubUser: async () => ({ login: "alice", id: 1, name: "Alice", email: "a@example.com" }),
      checkRepoAccess: async () => true,
      lifecycle: {
        currentBranch: async () => "tweaklet/x",
        changedFiles: async () => changed,
        repoSlugFromRemote: async () => ({ owner: "acme", name: "webapp" }),
        createDraftPr: async () => { pushed.push("pushed"); return "https://github.com/acme/webapp/pull/1"; },
      } as any,
    });
    const start = await request(app).get("/tweaklet/auth/login").expect(302);
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const sc = ([] as string[]).concat(start.headers["set-cookie"] as any).find((c) => c.startsWith("apz_oauth_state="))!.split(";")[0];
    const cb = await request(app).get(`/tweaklet/auth/callback?code=c&state=${state}`).set("Cookie", sc).expect(200);
    const session = ([] as string[]).concat(cb.headers["set-cookie"] as any).find((c) => c.startsWith("apz_session=") && !c.startsWith("apz_session=;"))!.split(";")[0];
    return { app, session };
  }
  it("refuses to submit a change that touches files outside the editable area, and lists them", async () => {
    const pushed: string[] = [];
    const { app, session } = await signedIn(["src/App.tsx", ".github/workflows/ci.yml"], pushed);
    const res = await request(app).post("/tweaklet/agent/pr").set("Cookie", session).send({}).expect(409);
    expect(res.body.files).toEqual([".github/workflows/ci.yml"]);
    expect(pushed).toEqual([]);
  });
  it("submits a change that stays inside the guardrails", async () => {
    const pushed: string[] = [];
    const { app, session } = await signedIn(["src/App.tsx"], pushed);
    await request(app).post("/tweaklet/agent/pr").set("Cookie", session).send({}).expect(200);
    expect(pushed).toEqual(["pushed"]);
  });
});

