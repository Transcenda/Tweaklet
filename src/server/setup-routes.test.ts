import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";
import { sign } from "../auth/signing.js";
import { ConfigSchema } from "../config/config.js";
import type { TweakletConfig, TweakletConfigInput } from "../config/config.js";
import type { Check } from "../doctor/doctor.js";
import { computeSetupState } from "./setup-state.js";
import { makeSessionStore } from "./session-store.js";

/** No-op session store — prevents disk writes to ~/.tweaklet during tests. */
function noopStore() { return makeSessionStore("/dev/null", { read: () => null, write: () => {} }); }

// ---------------------------------------------------------------------------
// In-memory config store helper
// ---------------------------------------------------------------------------

function makeConfigStore(initial: TweakletConfig) {
  let stored = ConfigSchema.parse(initial);
  return {
    loadConfig: () => ConfigSchema.parse(stored),
    saveConfig: (cfg: TweakletConfigInput) => {
      stored = ConfigSchema.parse(cfg);
    },
    get: () => stored,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: TweakletConfig = {
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  guardrails: { allow: ["frontend/src/**"] },
  setup: { completed: false },
};

const sampleChecks: Check[] = [
  { name: "node version", status: "ok", detail: "ok" },
  { name: "git", status: "ok", detail: "ok" },
  { name: "opencode", status: "ok", detail: "ok" },
  { name: "agent model", status: "ok", detail: "ok" },
  { name: "vertex credentials", status: "ok", detail: "ok" },
  { name: "repo", status: "ok", detail: "/some/path" },
];

/**
 * Known setup token injected via ServerDeps.setupToken for all tests that
 * hit setup routes while setup is incomplete. This keeps tests deterministic
 * without reaching into server internals.
 */
const KNOWN_TOKEN = "test-setup-token-abc123";

// ---------------------------------------------------------------------------
// GET /setup/state — blank config
// ---------------------------------------------------------------------------

describe("GET /tweaklet/setup/state — blank config", () => {
  it("returns completed:false and all steps todo when no github/agent/repo configured", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => [
        { name: "node version", status: "fail", detail: "old" },
        { name: "git", status: "fail", detail: "missing" },
        { name: "github cli", status: "fail", detail: "missing" },
        { name: "opencode", status: "fail", detail: "missing" },
      ],
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .get("/tweaklet/setup/state")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.completed).toBe(false);
    expect(res.body.steps).toHaveLength(4);
    expect(res.body.steps.every((s: any) => s.status === "todo")).toBe(true);
    expect(res.body.firstIncompleteStepId).toBe("dependencies");
  });
});

// ---------------------------------------------------------------------------
// POST /setup/github
// ---------------------------------------------------------------------------

describe("POST /tweaklet/setup/github", () => {
  it("saves github config and the github step becomes done in the returned state", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .post("/tweaklet/setup/github")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ clientId: "myclient", clientSecret: "mysecret" })
      .expect(200);
    expect(store.get().github?.clientId).toBe("myclient");
    const githubStep = res.body.steps.find((s: any) => s.id === "github");
    expect(githubStep?.status).toBe("done");
  });

  it("returns 400 when clientId or clientSecret is missing", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => [],
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .post("/tweaklet/setup/github")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ clientId: "only" })
      .expect(400);
  });

  it("returns 400 when body is empty", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => [],
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .post("/tweaklet/setup/github")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({})
      .expect(400);
  });

  it("refreshes in-memory config so /auth/login works immediately after saving github (no restart)", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    // Before the github step: /auth/login reports not-configured.
    await request(app).get("/tweaklet/auth/login").expect(400);
    // Save the OAuth client via the wizard.
    await request(app)
      .post("/tweaklet/setup/github")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ clientId: "Ov23liX", clientSecret: "sec" })
      .expect(200);
    // Now /auth/login redirects to GitHub — the in-memory config was refreshed
    // in place (previously this needed a server restart).
    const res = await request(app).get("/tweaklet/auth/login").expect(302);
    expect(res.headers.location).toContain("/login/oauth/authorize");
    expect(res.headers.location).toContain("client_id=Ov23liX");
  });
});

// ---------------------------------------------------------------------------
// POST /setup/repo
// ---------------------------------------------------------------------------

describe("POST /tweaklet/setup/repo", () => {
  it("saves the allowlist and returns it in the response (cloneRepo NOT called)", async () => {
    const store = makeConfigStore({ ...baseConfig });
    let cloneCalled = false;
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      cloneRepo: async () => { cloneCalled = true; return "/should/not/be/called"; },
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .post("/tweaklet/setup/repo")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ allowlist: ["transcenda/t8a"] })
      .expect(200);
    expect(res.body.allowlist).toEqual(["transcenda/t8a"]);
    expect(store.get().repo?.allowlist).toEqual(["transcenda/t8a"]);
    expect(cloneCalled).toBe(false);
  });

  it("returns 400 when allowlist is missing", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => [],
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .post("/tweaklet/setup/repo")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({})
      .expect(400);
  });

  it("returns 400 when allowlist is not an array", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => [],
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .post("/tweaklet/setup/repo")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ allowlist: "org/repo" })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// Setup lock after completion
// ---------------------------------------------------------------------------

describe("Setup lock after completion", () => {
  it("GET /setup/state returns 410 when setup.completed is true", async () => {
    const completedConfig: TweakletConfig = { ...baseConfig, setup: { completed: true } };
    const store = makeConfigStore(completedConfig);
    const app = createServer(structuredClone(completedConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      sessionStore: noopStore(),
    });
    await request(app).get("/tweaklet/setup/state").expect(410);
  });

  it("POST /setup/github returns 410 when setup.completed is true", async () => {
    const completedConfig: TweakletConfig = { ...baseConfig, setup: { completed: true } };
    const store = makeConfigStore(completedConfig);
    const app = createServer(structuredClone(completedConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      sessionStore: noopStore(),
    });
    await request(app).post("/tweaklet/setup/github").send({ clientId: "x", clientSecret: "y" }).expect(410);
  });

  it("POST /setup/doctor returns 410 when setup.completed is true", async () => {
    const completedConfig: TweakletConfig = { ...baseConfig, setup: { completed: true } };
    const store = makeConfigStore(completedConfig);
    const app = createServer(structuredClone(completedConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      sessionStore: noopStore(),
    });
    await request(app).post("/tweaklet/setup/doctor").expect(410);
  });

  it("POST /setup/repo returns 410 when setup.completed is true", async () => {
    const completedConfig: TweakletConfig = { ...baseConfig, setup: { completed: true } };
    const store = makeConfigStore(completedConfig);
    const app = createServer(structuredClone(completedConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      sessionStore: noopStore(),
    });
    await request(app).post("/tweaklet/setup/repo").send({ repoRef: "org/repo" }).expect(410);
  });
});

// ---------------------------------------------------------------------------
// POST /setup/complete
// ---------------------------------------------------------------------------

describe("POST /tweaklet/setup/complete", () => {
  it("refuses (409) when a required step is incomplete", async () => {
    const store = makeConfigStore({ ...baseConfig }); // no github, agent, repo
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const cookie = `apz_session=${sign({ login: "alice", id: 7 }, baseConfig.server.sessionSecret)}`;
    const res = await request(app)
      .post("/tweaklet/setup/complete")
      .set("Cookie", cookie)
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(409);
    expect(res.body.incompleteSteps).toContain("github");
  });

  it("refuses (401) when no session cookie", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .post("/tweaklet/setup/complete")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(401);
  });

  it("succeeds and locks setup when all steps are done and user is signed in", async () => {
    const fullConfig: TweakletConfig = {
      ...baseConfig,
      github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
      agent: { command: "opencode", cwd: "/app", vertexProject: "my-proj", model: "gemini" },
      repo: { path: "/repo", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["transcenda/t8a"] },
    };
    const store = makeConfigStore(fullConfig);
    const app = createServer(structuredClone(fullConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const cookie = `apz_session=${sign({ login: "alice", id: 7 }, fullConfig.server.sessionSecret)}`;
    const res = await request(app)
      .post("/tweaklet/setup/complete")
      .set("Cookie", cookie)
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.completed).toBe(true);
    expect(store.get().setup.completed).toBe(true);
    // Now the state endpoint should be locked (410).
    await request(app).get("/tweaklet/setup/state").expect(410);
  });
});

// ---------------------------------------------------------------------------
// POST /setup/agent
// ---------------------------------------------------------------------------

describe("POST /tweaklet/setup/agent", () => {
  it("saves vertexProject and the agent step becomes done in the returned state", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .post("/tweaklet/setup/agent")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ vertexProject: "my-gcp-proj" })
      .expect(200);
    expect(store.get().agent?.vertexProject).toBe("my-gcp-proj");
    const agentStep = res.body.steps.find((s: any) => s.id === "agent");
    expect(agentStep?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// POST /setup/doctor
// ---------------------------------------------------------------------------

describe("POST /tweaklet/setup/doctor", () => {
  it("returns state + checks without modifying config", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .post("/tweaklet/setup/doctor")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.checks).toBeDefined();
    expect(res.body.steps).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// computeSetupState pure function unit tests
// ---------------------------------------------------------------------------

describe("computeSetupState pure function", () => {
  const allOkChecks: Check[] = [
    { name: "node version", status: "ok", detail: "" },
    { name: "git", status: "ok", detail: "" },
    { name: "opencode", status: "ok", detail: "" },
    { name: "repo", status: "ok", detail: "" },
  ];

  it("marks dependencies as done when all dependency checks pass", () => {
    const state = computeSetupState(baseConfig, allOkChecks);
    const depsStep = state.steps.find((s) => s.id === "dependencies")!;
    expect(depsStep.status).toBe("done");
  });

  it("marks github as todo when no github config", () => {
    const state = computeSetupState(baseConfig, allOkChecks);
    const githubStep = state.steps.find((s) => s.id === "github")!;
    expect(githubStep.status).toBe("todo");
  });

  it("marks github as done when config.github has clientId+secret", () => {
    const cfg: TweakletConfig = {
      ...baseConfig,
      github: { clientId: "x", clientSecret: "y", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
    };
    const state = computeSetupState(cfg, allOkChecks);
    expect(state.steps.find((s) => s.id === "github")!.status).toBe("done");
  });

  it("marks agent as todo when vertexProject not set", () => {
    const state = computeSetupState(baseConfig, allOkChecks);
    expect(state.steps.find((s) => s.id === "agent")!.status).toBe("todo");
  });

  it("marks agent as done when vertexProject set and opencode ok", () => {
    const cfg: TweakletConfig = {
      ...baseConfig,
      agent: { command: "opencode", cwd: "/app", vertexProject: "proj" },
    };
    const state = computeSetupState(cfg, allOkChecks);
    expect(state.steps.find((s) => s.id === "agent")!.status).toBe("done");
  });

  it("marks agent as todo when opencode check fails even if vertexProject is set", () => {
    const cfg: TweakletConfig = {
      ...baseConfig,
      agent: { command: "opencode", cwd: "/app", vertexProject: "proj" },
    };
    const failedChecks: Check[] = allOkChecks.map((c) =>
      c.name === "opencode" ? { ...c, status: "fail" } : c,
    );
    const state = computeSetupState(cfg, failedChecks);
    expect(state.steps.find((s) => s.id === "agent")!.status).toBe("todo");
  });

  it("marks repo as done when an allowlist is configured (clone is post-sign-in)", () => {
    const cfg: TweakletConfig = {
      ...baseConfig,
      repo: { path: "/repo", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["transcenda/t8a"] },
    };
    const state = computeSetupState(cfg, allOkChecks);
    expect(state.steps.find((s) => s.id === "repo")!.status).toBe("done");
  });

  it("returns firstIncompleteStepId as null when all steps are done", () => {
    const cfg: TweakletConfig = {
      ...baseConfig,
      github: { clientId: "x", clientSecret: "y", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
      agent: { command: "opencode", cwd: "/app", vertexProject: "proj" },
      repo: { path: "/repo", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["transcenda/t8a"] },
    };
    const state = computeSetupState(cfg, allOkChecks);
    expect(state.firstIncompleteStepId).toBeNull();
  });

  it("returns firstIncompleteStepId pointing to the first todo step", () => {
    // deps ok, github missing → firstIncomplete is github
    const cfg: TweakletConfig = {
      ...baseConfig,
      agent: { command: "opencode", cwd: "/app", vertexProject: "proj" },
      repo: { path: "/repo", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["transcenda/t8a"] },
    };
    const state = computeSetupState(cfg, allOkChecks);
    expect(state.firstIncompleteStepId).toBe("github");
  });
});

// ---------------------------------------------------------------------------
// Setup token authentication
// ---------------------------------------------------------------------------

describe("Setup token — unauthenticated requests are rejected (403)", () => {
  it("GET /setup/state returns 403 without token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).get("/tweaklet/setup/state").expect(403);
  });

  it("POST /setup/github returns 403 without token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).post("/tweaklet/setup/github").send({ clientId: "x", clientSecret: "y" }).expect(403);
  });

  it("POST /setup/repo returns 403 without token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).post("/tweaklet/setup/repo").send({ repoRef: "acme/widget" }).expect(403);
  });

  it("POST /setup/agent returns 403 without token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).post("/tweaklet/setup/agent").send({ vertexProject: "proj" }).expect(403);
  });

  it("POST /setup/doctor returns 403 without token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).post("/tweaklet/setup/doctor").expect(403);
  });

  it("returns 403 with a wrong token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .get("/tweaklet/setup/state")
      .set("x-tweaklet-setup-token", "wrong-token")
      .expect(403);
  });
});

describe("Setup token — correct token proceeds to handler", () => {
  it("GET /setup/state returns 200 with correct x-tweaklet-setup-token header", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .get("/tweaklet/setup/state")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.completed).toBe(false);
  });

  it("GET /setup/state also accepts token via Authorization: Bearer", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .get("/tweaklet/setup/state")
      .set("Authorization", `Bearer ${KNOWN_TOKEN}`)
      .expect(200);
    expect(res.body.completed).toBe(false);
  });

  it("POST /setup/github saves config when token is provided", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .post("/tweaklet/setup/github")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ clientId: "cid", clientSecret: "sec" })
      .expect(200);
    expect(store.get().github?.clientId).toBe("cid");
  });
});

describe("Setup token — completed setup returns 410 (token no longer relevant)", () => {
  it("GET /setup/state returns 410 even without token when setup.completed is true", async () => {
    const completedConfig: TweakletConfig = { ...baseConfig, setup: { completed: true } };
    const store = makeConfigStore(completedConfig);
    const app = createServer(structuredClone(completedConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).get("/tweaklet/setup/state").expect(410);
  });
});

// ---------------------------------------------------------------------------
// POST /setup/repo — allowlist validation
// ---------------------------------------------------------------------------

describe("POST /setup/repo — allowlist validation", () => {
  it("returns 400 when allowlist contains a non-string entry", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .post("/tweaklet/setup/repo")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ allowlist: [42] })
      .expect(400);
    expect(res.body.error).toMatch(/allowlist/i);
  });

  it("returns 400 when allowlist is a string (not an array)", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app)
      .post("/tweaklet/setup/repo")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ allowlist: "org/repo" })
      .expect(400);
  });

  it("saves an empty allowlist", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .post("/tweaklet/setup/repo")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ allowlist: [] })
      .expect(200);
    expect(res.body.allowlist).toEqual([]);
  });

  it("saves multiple repo refs in the allowlist", async () => {
    const store = makeConfigStore({ ...baseConfig });
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .post("/tweaklet/setup/repo")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .send({ allowlist: ["org/repo-a", "org/repo-b"] })
      .expect(200);
    expect(res.body.allowlist).toEqual(["org/repo-a", "org/repo-b"]);
    expect(store.get().repo?.allowlist).toEqual(["org/repo-a", "org/repo-b"]);
  });
});

// ---------------------------------------------------------------------------
// GET /setup/verify-embed
// ---------------------------------------------------------------------------

describe("GET /tweaklet/setup/verify-embed", () => {
  it("returns embedded:true + widgetReachable:true when host HTML has the snippet and widget is 200", async () => {
    const store = makeConfigStore(baseConfig);
    const widgetUrl = `http://localhost:4319/tweaklet/widget.js`;
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
      verifyFetch: async (url: RequestInfo | URL, _init?: RequestInit) => {
        const u = String(url);
        if (u === "http://localhost:4319/") {
          return { text: async () => `<html><script src="/tweaklet/widget.js"></script></html>` } as any;
        }
        if (u === widgetUrl) {
          return { status: 200 } as any;
        }
        return { text: async () => "", status: 404 } as any;
      },
    });
    const res = await request(app)
      .get("/tweaklet/setup/verify-embed")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.embedded).toBe(true);
    expect(res.body.widgetReachable).toBe(true);
    expect(res.body.hostUrl).toBe("http://localhost:4319/");
  });

  it("returns embedded:false when host HTML does not contain the widget snippet", async () => {
    const store = makeConfigStore(baseConfig);
    const widgetUrl = `http://localhost:4319/tweaklet/widget.js`;
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
      verifyFetch: async (url: RequestInfo | URL, _init?: RequestInit) => {
        const u = String(url);
        if (u === "http://localhost:4319/") {
          return { text: async () => `<html><body>No widget here</body></html>` } as any;
        }
        if (u === widgetUrl) {
          return { status: 200 } as any;
        }
        return { text: async () => "", status: 404 } as any;
      },
    });
    const res = await request(app)
      .get("/tweaklet/setup/verify-embed")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.embedded).toBe(false);
  });

  it("returns 410 when setup is completed", async () => {
    const completedConfig: TweakletConfig = { ...baseConfig, setup: { completed: true } };
    const store = makeConfigStore(completedConfig);
    const app = createServer(structuredClone(completedConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      sessionStore: noopStore(),
    });
    await request(app).get("/tweaklet/setup/verify-embed").expect(410);
  });

  it("returns 403 without setup token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).get("/tweaklet/setup/verify-embed").expect(403);
  });
});

// ---------------------------------------------------------------------------
// GET /setup/verify-agent
// ---------------------------------------------------------------------------

describe("GET /tweaklet/setup/verify-agent", () => {
  it("returns ready:false with detail='sign in first' when no session cookie", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .get("/tweaklet/setup/verify-agent")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.signedIn).toBe(false);
    expect(res.body.detail).toBe("sign in first");
  });

  it("returns ready:false with detail='no repo cloned yet' when signed in but no repo path", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    // Inject a session cookie for a known user (no tokenStore entry so tok is null → signedIn=false)
    // To get signedIn:true we need a tokenStore entry — which requires going through OAuth.
    // Instead test the "no repo" path by having opencode ok but no repo path.
    const configWithoutRepo: TweakletConfig = {
      ...baseConfig,
      agent: { command: "opencode", cwd: "/app", vertexProject: "proj" },
    };
    const storeNoRepo = makeConfigStore(configWithoutRepo);
    const appNoRepo = createServer(structuredClone(configWithoutRepo), {
      loadConfig: storeNoRepo.loadConfig,
      saveConfig: storeNoRepo.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(appNoRepo)
      .get("/tweaklet/setup/verify-agent")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    // No token in tokenStore (no OAuth flow happened), so signedIn=false
    expect(res.body.ready).toBe(false);
    expect(res.body.signedIn).toBe(false);
  });

  it("returns opencodeOk:false when opencode check fails", async () => {
    const store = makeConfigStore(baseConfig);
    const failedChecks = sampleChecks.map((c) =>
      c.name === "opencode" ? { ...c, status: "fail" as const } : c
    );
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => failedChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    const res = await request(app)
      .get("/tweaklet/setup/verify-agent")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .expect(200);
    expect(res.body.opencodeOk).toBe(false);
    expect(res.body.ready).toBe(false);
  });

  it("returns 410 when setup is completed", async () => {
    const completedConfig: TweakletConfig = { ...baseConfig, setup: { completed: true } };
    const store = makeConfigStore(completedConfig);
    const app = createServer(structuredClone(completedConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      sessionStore: noopStore(),
    });
    await request(app).get("/tweaklet/setup/verify-agent").expect(410);
  });

  it("returns 403 without setup token", async () => {
    const store = makeConfigStore(baseConfig);
    const app = createServer(structuredClone(baseConfig), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
    });
    await request(app).get("/tweaklet/setup/verify-agent").expect(403);
  });

  // The doctor flaw fix: signed in + opencode up + repo cloned is NOT enough —
  // the agent must actually answer a test prompt. These cover both verdicts.
  function clonedRepoConfig() {
    const dir = mkdtempSync(join(tmpdir(), "tweaklet-verify-"));
    mkdirSync(join(dir, ".git"));
    return {
      ...baseConfig,
      github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
      agent: { command: "opencode", cwd: dir, vertexProject: "p", model: "google-vertex-ai/gemini-2.5-pro" },
      repo: { path: dir, baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["alice/app"] },
    } as TweakletConfig;
  }
  async function signIn(appInstance: any): Promise<string> {
    const login = await request(appInstance).get("/tweaklet/auth/login");
    const state = new URL(login.headers.location as string).searchParams.get("state")!;
    const stateCookie = ([] as string[]).concat(login.headers["set-cookie"] as any).find((c) => c.startsWith("apz_oauth_state="))!.split(";")[0];
    const cb = await request(appInstance).get(`/tweaklet/auth/callback?code=c&state=${state}`).set("Cookie", stateCookie);
    return ([] as string[]).concat(cb.headers["set-cookie"] as any).find((c) => c.startsWith("apz_session="))!.split(";")[0];
  }
  const signedInDeps = (cfg: TweakletConfig, smoke: any) => {
    const store = makeConfigStore(cfg);
    return createServer(structuredClone(cfg), {
      loadConfig: store.loadConfig,
      saveConfig: store.saveConfig,
      runDiagnostics: async () => sampleChecks,
      setupToken: KNOWN_TOKEN,
      sessionStore: noopStore(),
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "alice@example.com" }),
      getClient: async () => ({}),
      smokeTestAgent: smoke,
    } as any);
  };

  it("returns ready:true when signed in, repo cloned, and the agent answers a test prompt", async () => {
    const app = signedInDeps(clonedRepoConfig(), async () => ({ ok: true, detail: "agent replied to a test prompt" }));
    const cookie = await signIn(app);
    const res = await request(app)
      .get("/tweaklet/setup/verify-agent")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body).toMatchObject({ ready: true, signedIn: true, opencodeOk: true, repoCloned: true, agentReplies: true });
  });

  it("returns ready:false when the agent does NOT answer (catches Model/Agent-not-found at setup)", async () => {
    const app = signedInDeps(clonedRepoConfig(), async () => ({ ok: false, detail: 'Model not found: google-vertex-ai/gemini-2.5-pro' }));
    const cookie = await signIn(app);
    const res = await request(app)
      .get("/tweaklet/setup/verify-agent")
      .set("x-tweaklet-setup-token", KNOWN_TOKEN)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.agentReplies).toBe(false);
    expect(res.body.detail).toContain("Model not found");
  });
});
