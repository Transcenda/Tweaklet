import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer, issueSessionToken } from "./server.js";
import type { TweakletConfig } from "../config/config.js";
import { makeSessionStore } from "./session-store.js";

// A page on another site (or a sibling subdomain) must not be able to make the
// signed-in user's browser change anything — even body-less POSTs like reject.
const config: TweakletConfig = {
  server: { port: 4319, publicUrl: "https://app.example.com", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
  repo: { path: "/repo", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: [] },
  guardrails: { allow: ["src/**"] },
  setup: { completed: true },
};
const cookie = `apz_session=${issueSessionToken({ login: "alice", id: 1 }, config.server.sessionSecret)}`;
let undone = 0;
const app = () => createServer(config, {
  sessionStore: makeSessionStore("/dev/null", { read: () => null, write: () => {} }),
  lifecycle: { discard: async () => { undone++; }, currentBranch: async () => "tweaklet/x", branchOwner: async () => null } as any,
});

describe("cross-site request protection", () => {
  it.each(["cross-site", "same-site"])("refuses a state-changing request the browser marks %s", async (site) => {
    undone = 0;
    const res = await request(app()).post("/tweaklet/agent/undo").set("Cookie", cookie).set("Sec-Fetch-Site", site).expect(403);
    expect(res.body.error).toMatch(/cross-site/);
    expect(undone).toBe(0);
  });

  it("refuses a request from a foreign Origin (older browsers without Sec-Fetch-Site)", async () => {
    await request(app()).post("/tweaklet/agent/undo").set("Cookie", cookie).set("Origin", "https://evil.example").expect(403);
  });

  it("allows the widget's own same-origin requests", async () => {
    await request(app()).post("/tweaklet/agent/undo").set("Cookie", cookie).set("Sec-Fetch-Site", "same-origin").set("Origin", "https://app.example.com").expect(204);
  });

  it("allows non-browser clients that send neither header (CLI, tests)", async () => {
    await request(app()).post("/tweaklet/agent/undo").set("Cookie", cookie).expect(204);
  });

  it("leaves reads alone (GET is never state-changing)", async () => {
    await request(app()).get("/tweaklet/agent/me").set("Cookie", cookie).set("Sec-Fetch-Site", "cross-site").expect(200);
  });
});
