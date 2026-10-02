import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";
import { mcpToken } from "../agent/mcp-secret.js";

// Local-only surfaces (/auth/cli, /mcp) must stay local even when Tweaklet sits
// behind a reverse proxy on the same machine — where every request arrives on a
// loopback socket.
const base: TweakletConfig = {
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  guardrails: { allow: ["src/**"] },
  setup: { completed: true },
};
const withOAuth: TweakletConfig = {
  ...base,
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
};
const store = () => makeSessionStore("/dev/null", { read: () => null, write: () => {} });
const cliApp = (config: TweakletConfig = base) =>
  createServer(config, { ghCliUser: async () => ({ login: "operator", id: 1, name: "Op", email: "op@example.com" }), sessionStore: store() });

describe("/auth/cli is for the machine's own browser only", () => {
  it("works for a direct local request", async () => {
    await request(cliApp()).get("/tweaklet/auth/cli").expect(302);
  });

  it.each([
    ["X-Forwarded-For", "203.0.113.7"],
    ["Forwarded", "for=203.0.113.7"],
    ["X-Real-IP", "203.0.113.7"],
    ["Via", "1.1 caddy"],
  ])("refuses a request that came through a proxy (%s)", async (header, value) => {
    const res = await request(cliApp()).get("/tweaklet/auth/cli").set(header, value).expect(403);
    expect(res.body.error).toMatch(/local-only/);
  });

  it("refuses a request addressed to a public hostname (a proxy that adds no headers)", async () => {
    await request(cliApp()).get("/tweaklet/auth/cli").set("Host", "app.example.com").expect(403);
  });

  it("is off when GitHub sign-in is configured — servers use OAuth", async () => {
    const res = await request(cliApp(withOAuth)).get("/tweaklet/auth/cli");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/tweaklet/auth/login");
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("apz_session=");
  });
});

describe("/mcp requires the per-process token and a direct local connection", () => {
  const mcpBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const post = (app: ReturnType<typeof createServer>) =>
    request(app).post("/tweaklet/mcp").set("Accept", "application/json, text/event-stream").send(mcpBody);

  it("refuses a local request without the token", async () => {
    const res = await post(cliApp()).expect(403);
    expect(res.body.error).toMatch(/mcp/);
  });

  it("refuses a wrong token", async () => {
    await post(cliApp()).set("Authorization", "Bearer nope").expect(403);
  });

  it("refuses the right token when it came through a proxy", async () => {
    await post(cliApp()).set("Authorization", `Bearer ${mcpToken()}`).set("X-Forwarded-For", "203.0.113.7").expect(403);
  });

  it("serves opencode's local request with the token", async () => {
    const res = await post(cliApp()).set("Authorization", `Bearer ${mcpToken()}`);
    expect(res.status).not.toBe(403);
  });
});
