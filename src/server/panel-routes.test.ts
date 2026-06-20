import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

/** No-op session store — prevents disk writes to ~/.tweaklet during tests. */
function noopStore() { return makeSessionStore("/dev/null", { read: () => null, write: () => {} }); }

const config: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
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

describe("widget + bootstrap routes", () => {
  it("GET /tweaklet/widget.js serves JS (self-mounting bundle, no iframe)", async () => {
    const res = await request(appWith()).get("/tweaklet/widget.js").expect(200);
    expect(res.headers["content-type"]).toContain("javascript");
    // The shipped bundle is the Vite library output, not the old iframe snippet.
    expect(res.text).not.toContain("createElement('iframe')");
    expect(res.text).not.toContain("__TWEAKLET_BASE__");
  });

  it("GET /tweaklet/ serves the bootstrap HTML that loads widget.js", async () => {
    const res = await request(appWith()).get("/tweaklet/").expect(200);
    expect(res.headers["content-type"]).toContain("html");
    // The standalone marker tells the widget to render the centered setup card.
    expect(res.text).toContain(`<script src="/tweaklet/widget.js?standalone=1">`);
  });

  it("the old /tweaklet/panel route no longer exists (404)", async () => {
    await request(appWith()).get("/tweaklet/panel").expect(404);
    await request(appWith()).get("/tweaklet/panel/").expect(404);
  });
});
