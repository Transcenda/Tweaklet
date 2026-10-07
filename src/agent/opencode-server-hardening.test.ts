import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPrompt, startOpencode } from "./opencode-server.js";

function fakeSdk() {
  const seen: { options?: any; envAtSpawn?: Record<string, string | undefined>; clientConfig?: any } = {};
  const close = vi.fn();
  const sdk = {
    createOpencodeServer: vi.fn(async (options: any) => {
      seen.options = options;
      seen.envAtSpawn = {
        password: process.env.OPENCODE_SERVER_PASSWORD,
        username: process.env.OPENCODE_SERVER_USERNAME,
      };
      return { url: "http://127.0.0.1:51234", close };
    }),
    createOpencodeClient: vi.fn((config: any) => { seen.clientConfig = config; return { fake: true }; }),
  };
  return { sdk, seen, close };
}

describe("startOpencode — the local opencode API requires a per-spawn secret", () => {
  it("spawns opencode on loopback, a free port, with a random password, and the client sends it", async () => {
    const { sdk, seen } = fakeSdk();
    const before = { ...process.env };
    const r = await startOpencode(sdk, { permission: "ask" });

    expect(seen.options).toMatchObject({ hostname: "127.0.0.1", port: 0, config: { permission: "ask" } });
    const password = seen.envAtSpawn!.password!;
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(seen.envAtSpawn!.username).toBe("opencode");

    expect(seen.clientConfig.baseUrl).toBe("http://127.0.0.1:51234");
    const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    expect(seen.clientConfig.headers.Authorization).toBe(expected);
    expect(r.client).toEqual({ fake: true });

    // The secret is only in the child's environment, never left in ours.
    expect(process.env.OPENCODE_SERVER_PASSWORD).toBe(before.OPENCODE_SERVER_PASSWORD);
    expect(process.env.OPENCODE_SERVER_USERNAME).toBe(before.OPENCODE_SERVER_USERNAME);
  });

  it("uses a fresh secret for every spawn", async () => {
    const a = fakeSdk(); await startOpencode(a.sdk, {});
    const b = fakeSdk(); await startOpencode(b.sdk, {});
    expect(a.seen.envAtSpawn!.password).not.toBe(b.seen.envAtSpawn!.password);
  });

  it("restores a pre-existing operator value and still cleans up when the spawn fails", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "operator-value";
    try {
      const { sdk } = fakeSdk();
      sdk.createOpencodeServer.mockImplementationOnce(async () => { throw new Error("spawn failed"); });
      await expect(startOpencode(sdk, {})).rejects.toThrow("spawn failed");
      expect(process.env.OPENCODE_SERVER_PASSWORD).toBe("operator-value");
    } finally {
      delete process.env.OPENCODE_SERVER_PASSWORD;
    }
  });
});

// --- runPrompt with repoRoot: edits through symlinks are judged by their target.
function fakeClient() {
  const queue: any[] = []; let wake: (() => void) | null = null;
  const emit = (ev: any) => { queue.push(ev); wake?.(); wake = null; };
  const stream = (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift();
      await new Promise<void>((r) => (wake = r));
    }
  })();
  const perms: any[] = [];
  const client = {
    session: { create: vi.fn(async () => ({ data: { id: "ses_x" } })), prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}) },
    event: { subscribe: vi.fn(async () => ({ stream })) },
    postSessionIdPermissionsPermissionId: vi.fn(async (a: any) => { perms.push(a); }),
  };
  return { client, emit, perms };
}

let tmp: string;
let repo: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tweaklet-run-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "frontend/src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "backend"), { recursive: true });
  fs.symlinkSync("../../backend", path.join(repo, "frontend/src/x"));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("runPrompt — repoRoot", () => {
  it("rejects an edit that only looks in bounds because of a symlink, and reports it blocked", async () => {
    const { client, emit, perms } = fakeClient();
    const p = runPrompt({
      client, model: "p/m", prompt: "hi", allow: ["frontend/src/**"], repoRoot: repo,
      onEvent: () => {}, onAsk: async () => "approve", graceMs: 30,
    });
    emit({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_x", permission: "edit", patterns: ["frontend/src/x/main.rs"] } });
    emit({ type: "permission.asked", properties: { id: "per_2", sessionID: "ses_x", permission: "edit", patterns: ["frontend/src/App.tsx"] } });
    emit({ type: "session.idle", properties: { sessionID: "ses_x" } });
    const r = await p;
    expect(perms.map((x) => x.body.response)).toEqual(["reject", "once"]);
    expect(r.blocked).toEqual(["frontend/src/x/main.rs"]);
  });
});
