# tweaklet v1 — Plan 2: Agent Loop (drive Gemini CLI, stream progress)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user POSTs a prompt; tweaklet runs Gemini CLI headless in a configured working directory and streams the agent's progress (assistant text, tool activity, completion) back to the browser live over SSE.

**Architecture:** A pure NDJSON event normalizer (`agent/events.ts`) maps Gemini CLI's `stream-json` lines into a small `AgentEvent` union. A runner (`agent/runner.ts`) spawns the configured command (default `gemini -p <prompt> --output-format stream-json`) in a cwd with Vertex env, splits stdout into lines, normalizes each, and invokes an `onEvent` callback; the child-spawn is dependency-injected. The server gains `POST /api/agent/prompt` (auth-gated) that runs the agent and writes each event as an SSE frame; a single-active-run guard returns 409 if one is in flight. The runner is injected into `createServer` so the endpoint is tested with a fake runner.

**Tech Stack:** Node 20+ (`node:child_process`), TypeScript (ESM), Express, Zod, Vitest + Supertest. Builds on Plan 1.

> **Spec:** [`../specs/2026-06-11-universal-ai-sandbox-design.md`](../specs/2026-06-11-universal-ai-sandbox-design.md) §6.2 (agent = drive Gemini CLI on Vertex, headless `stream-json`), §6.3 (cursor-like progress driven by the stream).
>
> **Gemini CLI `stream-json` schema (verified from docs):** newline-delimited JSON; event `type` ∈ `init` (session_id, model), `message` (role, content — string or parts), `tool_use` (tool_name, tool_id, args), `tool_result` (tool_id, status, output), `error` (message), `result` (final + token stats). Headless prompt via `-p "<prompt>"`. The exact sub-field names are not fully pinned in the docs, so the normalizer reads them **defensively** (tries common aliases, always keeps `raw`); the real field mapping is confirmed in the manual smoke (Task 6).
>
> **Location:** `tweaklet/` on branch `spike/ai-sandbox`. No worktree. Continues from Plan 1 (HEAD `e334e261`).

---

### Task 1: Extend config with an optional `agent` block

**Files:**
- Modify: `tweaklet/src/config/config.ts`
- Test: `tweaklet/src/config/config.test.ts` (add a case)

> The block is **optional** so all existing Plan-1 configs/tests still validate. Plan 3 will populate it from the wizard. `command` defaults to `gemini`.

- [ ] **Step 1: Add a failing test** — append inside `describe("config", ...)` in `config.test.ts`:

```ts
  it("accepts and round-trips an optional agent block", () => {
    const withAgent = {
      ...valid,
      agent: { command: "gemini", cwd: "/home/tweaklet/app", vertexProject: "my-gcp-proj" },
    };
    saveConfig(withAgent);
    const loaded = loadConfig();
    expect(loaded.agent).toEqual({ command: "gemini", cwd: "/home/tweaklet/app", vertexProject: "my-gcp-proj" });
  });

  it("still loads a config with no agent block (agent is optional)", () => {
    saveConfig(valid); // `valid` has no agent block
    expect(loadConfig().agent).toBeUndefined();
  });
```

Run: `npx vitest run src/config/config.test.ts` → expect the new `agent` test to FAIL (Zod strips/rejects the unknown key, so `loaded.agent` is undefined).

- [ ] **Step 2: Add the `agent` block to `ConfigSchema`** in `config.ts` (inside the top-level `z.object({ ... })`, after `server`):

```ts
  agent: z
    .object({
      command: z.string().min(1).default("gemini"),
      cwd: z.string().min(1),
      vertexProject: z.string().optional(),
    })
    .optional(),
```

Run: `npx vitest run src/config/config.test.ts` → expect all config tests PASS.

- [ ] **Step 3: Full suite + commit**

Run `cd /Users/joseph/Projects/transcenda/t8a/tweaklet && npm test` (expect 21 total). Then:
```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat(tweaklet): optional agent config block (command/cwd/vertexProject)"
```

---

### Task 2: Normalize Gemini CLI stream-json events

**Files:**
- Create: `tweaklet/src/agent/events.ts`
- Test: `tweaklet/src/agent/events.test.ts`

- [ ] **Step 1: Write the failing test** (`src/agent/events.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { parseAgentLine, type AgentEvent } from "./events.js";

describe("parseAgentLine", () => {
  it("returns null for blank or whitespace lines", () => {
    expect(parseAgentLine("")).toBeNull();
    expect(parseAgentLine("   ")).toBeNull();
  });

  it("returns null for non-JSON lines (stray stdout)", () => {
    expect(parseAgentLine("Loading model...")).toBeNull();
  });

  it("normalizes an init event", () => {
    const e = parseAgentLine(JSON.stringify({ type: "init", session_id: "s1", model: "gemini-x" }))!;
    expect(e.type).toBe("init");
    expect(e).toMatchObject({ sessionId: "s1", model: "gemini-x" });
  });

  it("extracts text from a message with string content", () => {
    const e = parseAgentLine(JSON.stringify({ type: "message", role: "assistant", content: "Hello" }))!;
    expect(e).toMatchObject({ type: "message", role: "assistant", text: "Hello" });
  });

  it("extracts text from a message with array-of-parts content", () => {
    const e = parseAgentLine(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }] }))!;
    expect(e).toMatchObject({ type: "message", text: "Hi there" });
  });

  it("normalizes a tool_use event (tool_name alias)", () => {
    const e = parseAgentLine(JSON.stringify({ type: "tool_use", tool_name: "write_file", tool_id: "t1" }))!;
    expect(e).toMatchObject({ type: "tool_use", toolName: "write_file", toolId: "t1" });
  });

  it("normalizes a tool_result event", () => {
    const e = parseAgentLine(JSON.stringify({ type: "tool_result", tool_id: "t1", status: "success" }))!;
    expect(e).toMatchObject({ type: "tool_result", toolId: "t1", status: "success" });
  });

  it("normalizes an error event", () => {
    const e = parseAgentLine(JSON.stringify({ type: "error", message: "rate limited" }))!;
    expect(e).toMatchObject({ type: "error", message: "rate limited" });
  });

  it("passes a result event through", () => {
    const e = parseAgentLine(JSON.stringify({ type: "result", stats: { tokens: 10 } }))!;
    expect(e.type).toBe("result");
  });

  it("labels unknown event types as 'unknown' but keeps raw", () => {
    const e = parseAgentLine(JSON.stringify({ type: "weird", foo: 1 }))!;
    expect(e.type).toBe("unknown");
    expect((e as Extract<AgentEvent, { type: "unknown" }>).raw).toMatchObject({ type: "weird", foo: 1 });
  });
});
```

Run: `npx vitest run src/agent/events.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement** (`src/agent/events.ts`):

```ts
export type AgentEvent =
  | { type: "init"; sessionId?: string; model?: string; raw: unknown }
  | { type: "message"; role?: string; text: string; raw: unknown }
  | { type: "tool_use"; toolName?: string; toolId?: string; raw: unknown }
  | { type: "tool_result"; toolId?: string; status?: string; raw: unknown }
  | { type: "error"; message: string; raw: unknown }
  | { type: "result"; raw: unknown }
  | { type: "unknown"; raw: unknown };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof (p as any)?.text === "string" ? (p as any).text : ""))
      .join("");
  }
  if (content && typeof (content as any).text === "string") return (content as any).text;
  return "";
}

export function parseAgentLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null; // stray non-JSON stdout — ignore
  }
  if (!obj || typeof obj !== "object") return null;
  switch (obj.type) {
    case "init":
      return { type: "init", sessionId: obj.session_id ?? obj.sessionId, model: obj.model, raw: obj };
    case "message":
      return { type: "message", role: obj.role, text: extractText(obj.content), raw: obj };
    case "tool_use":
      return { type: "tool_use", toolName: obj.tool_name ?? obj.name, toolId: obj.tool_id ?? obj.id, raw: obj };
    case "tool_result":
      return { type: "tool_result", toolId: obj.tool_id ?? obj.id, status: obj.status, raw: obj };
    case "error":
      return { type: "error", message: String(obj.message ?? obj.error ?? "agent error"), raw: obj };
    case "result":
      return { type: "result", raw: obj };
    default:
      return { type: "unknown", raw: obj };
  }
}
```

Run: `npx vitest run src/agent/events.test.ts` → PASS (10 tests).

- [ ] **Step 3: Full suite + commit**

Run `npm test` (expect 31 total). Then:
```bash
git add src/agent/events.ts src/agent/events.test.ts
git commit -m "feat(tweaklet): normalize Gemini CLI stream-json events"
```

---

### Task 3: The agent runner (spawn + line-buffer + stream events)

**Files:**
- Create: `tweaklet/src/agent/runner.ts`
- Test: `tweaklet/src/agent/runner.test.ts`

> The runner spawns the configured command, buffers stdout into complete lines (chunks can split a line), normalizes each via `parseAgentLine`, and calls `onEvent`. The test spawns a **real `node -e` script** as the fake agent (no mocking of `child_process` internals) so the spawn + line-buffer + parse path is genuinely exercised.

- [ ] **Step 1: Write the failing test** (`src/agent/runner.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { runAgent } from "./runner.js";
import type { AgentEvent } from "./events.js";

// A fake "gemini": a node script that prints 3 NDJSON events (one split across writes) then exits 0.
const FAKE = `
process.stdout.write(JSON.stringify({type:"init",session_id:"s1",model:"m"})+"\\n");
process.stdout.write(JSON.stringify({type:"message",role:"assistant",content:"hi"})+"\\n");
const half = JSON.stringify({type:"result",stats:{tokens:1}});
process.stdout.write(half.slice(0,5));
setTimeout(()=>{ process.stdout.write(half.slice(5)+"\\n"); process.exit(0); }, 10);
`;

describe("runAgent", () => {
  it("spawns the command, streams normalized events, resolves with exit code", async () => {
    const events: AgentEvent[] = [];
    const { code } = await runAgent(
      { command: process.execPath, args: ["-e", FAKE], cwd: process.cwd(), env: {}, prompt: "ignored-by-fake", onEvent: (e) => events.push(e) },
    );
    expect(code).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["init", "message", "result"]);
    expect(events[1]).toMatchObject({ type: "message", text: "hi" });
  });

  it("surfaces a nonzero exit code", async () => {
    const { code } = await runAgent(
      { command: process.execPath, args: ["-e", "process.exit(3)"], cwd: process.cwd(), env: {}, prompt: "x", onEvent: () => {} },
    );
    expect(code).toBe(3);
  });
});
```

Run: `npx vitest run src/agent/runner.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement** (`src/agent/runner.ts`):

```ts
import { spawn as realSpawn, type SpawnOptions } from "node:child_process";
import { parseAgentLine, type AgentEvent } from "./events.js";

export interface RunAgentArgs {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string; // for the real command this is passed via args by the caller; kept for logging/context
  onEvent: (e: AgentEvent) => void;
}

type SpawnLike = typeof realSpawn;

export function runAgent(args: RunAgentArgs, spawnImpl: SpawnLike = realSpawn): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = { cwd: args.cwd, env: { ...process.env, ...args.env }, stdio: ["ignore", "pipe", "pipe"] };
    const child = spawnImpl(args.command, args.args, opts);
    let buf = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const ev = parseAgentLine(line);
        if (ev) args.onEvent(ev);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (buf.trim()) {
        const ev = parseAgentLine(buf);
        if (ev) args.onEvent(ev);
      }
      resolve({ code: code ?? 0 });
    });
  });
}
```

Run: `npx vitest run src/agent/runner.test.ts` → PASS (2 tests).

- [ ] **Step 3: Full suite + commit**

Run `npm test` (expect 33 total). Then:
```bash
git add src/agent/runner.ts src/agent/runner.test.ts
git commit -m "feat(tweaklet): agent runner — spawn, line-buffer, stream normalized events"
```

---

### Task 4: `POST /api/agent/prompt` — run the agent, stream SSE

**Files:**
- Modify: `tweaklet/src/server/server.ts`
- Test: `tweaklet/src/server/agent-routes.test.ts`

> The endpoint is auth-gated, runs the agent, and writes each `AgentEvent` as an SSE frame (`data: <json>\n\n`), ending with a terminal `data: {"type":"end","code":N}` frame. A single-active-run guard returns 409 while a run is in flight. The runner is injected via `deps.runAgent` so the test uses a fake that emits canned events without spawning anything. The real argv (`-p <prompt> --output-format stream-json`) + Vertex env are built from `config.agent`; if `config.agent` is absent → 400.

- [ ] **Step 1: Write the failing test** (`src/server/agent-routes.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";
import type { AgentEvent } from "../agent/events.js";

const base: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
  agent: { command: "gemini", cwd: "/tmp/app" },
};
const authCookie = `apz_session=${sign({ login: "alice", id: 7 }, base.server.sessionSecret)}`;

function appWith(deps = {}, config: TweakletConfig = base) {
  return createServer(config, {
    exchangeCodeForToken: async () => "tok",
    fetchGithubUser: async () => ({ login: "alice", id: 7 }),
    ...deps,
  });
}

const fakeRun = async (args: { onEvent: (e: AgentEvent) => void }) => {
  args.onEvent({ type: "init", sessionId: "s1", raw: {} });
  args.onEvent({ type: "message", role: "assistant", text: "done", raw: {} });
  args.onEvent({ type: "result", raw: {} });
  return { code: 0 };
};

describe("POST /api/agent/prompt", () => {
  it("401s without a session", async () => {
    await request(appWith({ runAgent: fakeRun })).post("/api/agent/prompt").send({ prompt: "x" }).expect(401);
  });

  it("400s when no agent is configured", async () => {
    const noAgent = { ...base, agent: undefined };
    await request(appWith({ runAgent: fakeRun }, noAgent)).post("/api/agent/prompt").set("Cookie", authCookie).send({ prompt: "x" }).expect(400);
  });

  it("400s on an empty prompt", async () => {
    await request(appWith({ runAgent: fakeRun })).post("/api/agent/prompt").set("Cookie", authCookie).send({ prompt: "  " }).expect(400);
  });

  it("streams SSE frames for each event and a terminal end frame", async () => {
    const res = await request(appWith({ runAgent: fakeRun }))
      .post("/api/agent/prompt").set("Cookie", authCookie).send({ prompt: "make it bigger" })
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('data: {"type":"init"');
    expect(res.text).toContain('"text":"done"');
    expect(res.text).toContain('"type":"end","code":0');
  });

  it("passes the right argv + cwd to the runner", async () => {
    let captured: any = null;
    const spy = async (a: any) => { captured = a; a.onEvent({ type: "result", raw: {} }); return { code: 0 }; };
    await request(appWith({ runAgent: spy })).post("/api/agent/prompt").set("Cookie", authCookie).send({ prompt: "hello" }).expect(200);
    expect(captured.command).toBe("gemini");
    expect(captured.cwd).toBe("/tmp/app");
    expect(captured.args).toEqual(["-p", "hello", "--output-format", "stream-json"]);
  });
});
```

Run: `npx vitest run src/server/agent-routes.test.ts` → FAIL (route 404 / not implemented).

- [ ] **Step 2: Implement** — in `src/server/server.ts`:

(a) Extend `ServerDeps` and imports at the top:
```ts
import express from "express";
import { runAgent as realRunAgent } from "../agent/runner.js";
import type { AgentEvent } from "../agent/events.js";
```
Add to `ServerDeps`:
```ts
  runAgent?: typeof realRunAgent;
```

(b) Inside `createServer`, after `const fetchUser = ...`:
```ts
  const runAgent = deps.runAgent ?? realRunAgent;
  let agentRunning = false;
```

(c) Ensure JSON body parsing is enabled (add once, right after `const app = express();`):
```ts
  app.use(express.json());
```

(d) Add the route (after `/api/me`):
```ts
  app.post("/api/agent/prompt", authGate, async (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!config.agent) {
      res.status(400).json({ error: "no agent configured" });
      return;
    }
    if (!prompt) {
      res.status(400).json({ error: "empty prompt" });
      return;
    }
    if (agentRunning) {
      res.status(409).json({ error: "an agent run is already in progress" });
      return;
    }
    agentRunning = true;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (e: AgentEvent | { type: "end"; code: number }) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    try {
      const env: NodeJS.ProcessEnv = {};
      if (config.agent.vertexProject) {
        env.GOOGLE_GENAI_USE_VERTEXAI = "true";
        env.GOOGLE_CLOUD_PROJECT = config.agent.vertexProject;
      }
      const { code } = await runAgent({
        command: config.agent.command,
        args: ["-p", prompt, "--output-format", "stream-json"],
        cwd: config.agent.cwd,
        env,
        prompt,
        onEvent: send,
      });
      send({ type: "end", code });
    } catch (e) {
      send({ type: "error", message: String(e), raw: {} } as AgentEvent);
      send({ type: "end", code: -1 });
    } finally {
      agentRunning = false;
      res.end();
    }
  });
```

Run: `npx vitest run src/server/agent-routes.test.ts` → PASS (5 tests). Then `npx vitest run src/server/server.test.ts` to confirm the existing 5 server tests still pass (the added `express.json()` is harmless to them).

- [ ] **Step 3: Full suite + build + commit**

Run `npm run build` (must stay clean) and `npm test` (expect 38 total). Then:
```bash
git add src/server/server.ts src/server/agent-routes.test.ts
git commit -m "feat(tweaklet): POST /api/agent/prompt streams Gemini CLI progress over SSE"
```

---

### Task 5: Manual smoke (real Gemini CLI on Vertex) — operator step

**Files:** none (documentation/verification only).

> This requires Gemini CLI installed + the operator's Vertex creds, so it is **not automated**. Capture the result in the commit message of any follow-up fix if the real schema differs from the normalizer's assumptions (Task 2).

- [ ] **Step 1: Install Gemini CLI + configure Vertex** (operator):
```bash
npm install -g @google/gemini-cli   # or npx @google/gemini-cli
export GOOGLE_GENAI_USE_VERTEXAI=true
export GOOGLE_CLOUD_PROJECT=<your-gcp-project>
gcloud auth application-default login   # if not already
```

- [ ] **Step 2: Confirm the raw stream-json schema matches the normalizer.** In any git repo dir:
```bash
gemini -p "list the files in this directory" --output-format stream-json | head -20
```
Confirm the lines are NDJSON with `type` ∈ {init, message, tool_use, tool_result, error, result} and that `parseAgentLine` extracts text/tool names correctly. **If field names differ** (e.g. message content shape), open `src/agent/events.ts`, adjust the aliases, update `events.test.ts` with a real captured line, and commit `fix(tweaklet): align stream-json normalizer with real Gemini CLI schema`.

- [ ] **Step 3: End-to-end via tweaklet.** With an `agent` block in `~/.tweaklet/config.json` (`command: "gemini"`, `cwd: <a repo>`, `vertexProject: <proj>`) and `tweaklet serve` running + signed in:
```bash
curl -N -H "Cookie: apz_session=<your session>" -H "Content-Type: application/json" \
  -d '{"prompt":"add a comment to the top of README"}' \
  http://localhost:4319/api/agent/prompt
```
Confirm SSE frames stream and the file is actually edited in `cwd`.

---

## Self-Review

**Spec coverage (Plan 2 scope = §6.2 agent, §6.3 progress stream):**
- Drive Gemini CLI headless on Vertex (`-p … --output-format stream-json`, `GOOGLE_GENAI_USE_VERTEXAI`/`GOOGLE_CLOUD_PROJECT` env) → Task 4 argv/env (verified by Task 4 Step-1 test "passes the right argv + cwd") + Task 5 real smoke. ✓
- Normalize the stream for the cursor-like progress UI → Tasks 2–3 (parser + runner), surfaced via SSE in Task 4. ✓ (The panel that *renders* these frames is Plan 3/4.)
- Backend-agnostic seam → `runAgent` is injected; the command is config-driven (`config.agent.command`), so swapping to another CLI is a config + argv change. ✓
- Single-session (no per-user isolation) → the `agentRunning` 409 guard enforces one run at a time. ✓

**Placeholder scan:** none — every step has runnable code or an exact command. The only non-automated step (Task 5) is explicitly an operator smoke that needs real Vertex creds, and is labelled as such.

**Type consistency:** `AgentEvent` (events.ts) is consumed unchanged by `runner.ts` (`onEvent: (e: AgentEvent) => void`) and `server.ts` (`send`); `RunAgentArgs`/`runAgent` signature matches the Task-4 injection and the Task-3 tests; `config.agent` shape (command/cwd/vertexProject) matches Task 1's schema and Task 4's usage.
