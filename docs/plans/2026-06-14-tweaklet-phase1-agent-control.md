# tweaklet Phase 1 — Agent Control & Safety (modes + guardrails + stop)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Make the tweaklet agent safe for non-technical users: a read-only **Explore** mode and a UI-only **Build** mode, both enforced by opencode's native per-agent permissions (hard, tool-level), plus a **Stop** kill-switch and a confirm-before-discard safety-net sweep.

**Architecture:** tweaklet invokes `opencode run --agent explore|build` against the target repo. Two project agent files (`.opencode/agent/*.md`) define the permission matrix — opencode *removes denied tools from the model*, so Explore physically cannot write and Build physically cannot edit outside the configured UI globs. tweaklet adds: a `mode` param on the agent route, an `AbortController`→child-kill for Stop, and a post-run sweep that reports (never auto-discards) anything outside the allow-set.

**Tech Stack:** Node/TS (tweaklet backend), Vitest, Express; React (panel); opencode (agent) on Vertex.

**Spec:** [`../specs/2026-06-14-tweaklet-agent-control-safety-design.md`](../specs/2026-06-14-tweaklet-agent-control-safety-design.md).
**Location:** `tweaklet/` + `tweaklet/web/` + dogfood agent files in the t8a repo root (`.opencode/agent/`). Trunk-based on `main`; run the full gate before each push.

---

### Task 1: Explore/Build opencode agents + empirically pin the invocation

**Files:** Create `/.opencode/agent/explore.md`, `/.opencode/agent/build.md` (t8a repo root — the dogfood target).

> This task is config + **empirical verification** (no unit test). It determines the exact `opencode run` invocation the server uses in Task 5.

- [ ] **Step 1: Create `.opencode/agent/explore.md`**
```markdown
---
description: Read-only exploration for non-technical users — explains how the app works, never changes it.
mode: primary
permission:
  edit: deny
  write: deny
  bash: deny
  webfetch: deny
---
You are tweaklet in EXPLORE mode, helping a non-technical teammate (PM or designer) understand a live web app.
You have READ-ONLY access. You cannot and must not modify any file.
Explain clearly, in plain language, how features work, where they live, and what would be involved in changing them.
When the user wants to actually build something, tell them to switch to Build mode.
```

- [ ] **Step 2: Create `.opencode/agent/build.md`** (allow/deny only — NO `ask`, so headless runs never block)
```markdown
---
description: UI-only builder — creates/edits front-end UI and drafts a PR. Cannot touch backend, data, infra, or build config.
mode: primary
permission:
  edit:
    "frontend/src/**": allow
    "*": deny
  write:
    "frontend/src/**": allow
    "*": deny
  bash:
    "npm run *": allow
    "npm test*": allow
    "npx tsc*": allow
    "git push*": deny
    "rm *": deny
    "*": deny
  webfetch: deny
---
You are tweaklet in BUILD mode, prototyping UI for a non-technical teammate.
You may ONLY create or edit front-end UI files under frontend/src/**. Pull data through EXISTING APIs.
You are NOT allowed to change: backend code, the data model, database migrations, background jobs,
infrastructure, CI/CD, build pipelines, or dependency/config files.
If a request requires any of those, DO NOT attempt it. Instead, clearly explain to the user, in plain
language, WHY it can't be done here (e.g. "that needs a new database field — a backend change") and that
it should be handed to the development team. Keep changes minimal and non-invasive.
```

- [ ] **Step 3: Verify Explore is read-only (real opencode)**
Run (note the absolute opencode path + Vertex env from `~/.tweaklet/config.json`):
```bash
OC=/opt/homebrew/Cellar/node/25.9.0_2/bin/opencode
cd /Users/joseph/Projects/transcenda/t8a
GOOGLE_CLOUD_PROJECT=ai-adoption-488503 VERTEX_LOCATION=global timeout 120 "$OC" run --agent explore --format json -m google-vertex-ai/gemini-2.5-flash -- "Create a file called GUARDRAIL_TEST.txt with the word HELLO" > /tmp/explore.json 2>&1
git status --porcelain | grep GUARDRAIL_TEST && echo "FAIL: explore wrote a file" || echo "PASS: explore is read-only"
grep -o '"tool":"[a-z]*"' /tmp/explore.json | sort -u   # expect read/grep/glob/list only, no write/edit
```
Expected: **PASS: explore is read-only**, no `GUARDRAIL_TEST.txt`. Clean up: `rm -f /tmp/explore.json`.

- [ ] **Step 4: Verify Build allows UI + blocks non-UI, headless, WITHOUT the skip-permissions flag**
```bash
cd /Users/joseph/Projects/transcenda/t8a
# (a) in-bounds edit should SUCCEED without hanging:
GOOGLE_CLOUD_PROJECT=ai-adoption-488503 VERTEX_LOCATION=global timeout 150 "$OC" run --agent build --format json -m google-vertex-ai/gemini-2.5-flash -- "Append a comment line '// tweaklet guardrail probe' to frontend/src/main.tsx" > /tmp/b1.json 2>&1
git diff --stat frontend/src/main.tsx   # expect 1 changed line
git checkout -- frontend/src/main.tsx   # revert the probe
# (b) out-of-bounds edit should be BLOCKED (agent declines/cannot):
GOOGLE_CLOUD_PROJECT=ai-adoption-488503 VERTEX_LOCATION=global timeout 150 "$OC" run --agent build --format json -m google-vertex-ai/gemini-2.5-flash -- "Add a field to backend/Cargo.toml" > /tmp/b2.json 2>&1
git status --porcelain | grep -E "Cargo.toml|backend/" && echo "FAIL: build touched backend" || echo "PASS: backend blocked"
```
Expected: (a) `main.tsx` changed then reverted (no hang → headless works without the flag); (b) **PASS: backend blocked**.
**Decision recorded for Task 5:** if (a) succeeded without `--dangerously-skip-permissions`, the server invocation **drops the flag** and uses `--agent`. If (a) hung or did nothing, the fallback is to **keep `--dangerously-skip-permissions`** (explicit `deny` rules still block out-of-bounds) — note which in the commit message. Clean up `/tmp/b*.json`.

- [ ] **Step 5: Commit**
```bash
cd /Users/joseph/Projects/transcenda/t8a
git add .opencode/agent/explore.md .opencode/agent/build.md
git commit -m "feat(tweaklet): opencode Explore (read-only) + Build (UI-only) agents with permission matrix"
git push origin HEAD:main
```

---

### Task 2: Config — guardrails allow-list + default mode

**Files:** Modify `tweaklet/src/config/config.ts`; modify `tweaklet/src/config/config.test.ts`.

- [ ] **Step 1: Failing test** — add to `config.test.ts`:
```ts
it("defaults guardrails.allow to the UI source glob", () => {
  const cfg = ConfigSchema.parse({
    server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
  });
  expect(cfg.guardrails.allow).toEqual(["frontend/src/**"]);
});
it("accepts custom guardrails.allow", () => {
  const cfg = ConfigSchema.parse({
    server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
    guardrails: { allow: ["web/src/**", "ui/**"] },
  });
  expect(cfg.guardrails.allow).toEqual(["web/src/**", "ui/**"]);
});
```
Run `cd tweaklet && npx vitest run src/config/config.test.ts` → FAIL.

- [ ] **Step 2: Implement** — in `config.ts` `ConfigSchema`, add:
```ts
  guardrails: z
    .object({ allow: z.array(z.string()).default(["frontend/src/**"]) })
    .default({ allow: ["frontend/src/**"] }),
```
Run the test → PASS.

- [ ] **Step 3: Commit**
```bash
git add tweaklet/src/config/config.ts tweaklet/src/config/config.test.ts
git commit -m "feat(tweaklet): config.guardrails.allow (UI allow-globs for the safety-net sweep)"
```

---

### Task 3: Runner — abortable child (Stop)

**Files:** Modify `tweaklet/src/agent/runner.ts`; modify `tweaklet/src/agent/runner.test.ts`.

> `RunAgentArgs` gains an optional `signal: AbortSignal`. When aborted, kill the child process; the run resolves with a sentinel code.

- [ ] **Step 1: Failing test** — add to `runner.test.ts` (mirror the existing fake-spawn pattern; the fake child must record `kill`):
```ts
it("kills the child when the abort signal fires", async () => {
  const killed: string[] = [];
  const fakeChild: any = {
    stdout: { on: () => {} }, stderr: { on: () => {} },
    on: (ev: string, cb: any) => { if (ev === "close") fakeChild._close = cb; },
    kill: (sig?: string) => { killed.push(sig ?? "SIGTERM"); fakeChild._close?.(null, sig); },
  };
  const spawn = () => fakeChild;
  const ac = new AbortController();
  const p = runAgent({ command: "x", args: [], cwd: "/", env: {}, prompt: "p", onEvent: () => {}, signal: ac.signal }, spawn);
  ac.abort();
  await p;
  expect(killed.length).toBeGreaterThan(0);
});
```
Run `npx vitest run src/agent/runner.test.ts` → FAIL.

- [ ] **Step 2: Implement** — in `runner.ts`:
  - Add `signal?: AbortSignal;` to `RunAgentArgs`.
  - After the child is spawned, wire abort:
```ts
  if (args.signal) {
    if (args.signal.aborted) child.kill("SIGTERM");
    else args.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  }
```
Run the test → PASS. Then `npx vitest run src/agent/runner.test.ts` (all runner tests) → green.

- [ ] **Step 3: Commit**
```bash
git add tweaklet/src/agent/runner.ts tweaklet/src/agent/runner.test.ts
git commit -m "feat(tweaklet): runner accepts AbortSignal and kills the child on abort"
```

---

### Task 4: Guardrails module — partition repo changes by allow-globs

**Files:** Create `tweaklet/src/guardrails/guardrails.ts`, `tweaklet/src/guardrails/guardrails.test.ts`.

> Pure logic: given the list of changed paths (from `git status --porcelain`) and the allow-globs, return `{ allowed, blocked }`. Glob matching is minimal (supports `**` and `*` segment matching) — no new dependency.

- [ ] **Step 1: Failing test** (`guardrails.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import { matchesAllow, partitionChanges } from "./guardrails.js";

describe("guardrails", () => {
  it("matches ** globs", () => {
    expect(matchesAllow("frontend/src/app/X.tsx", ["frontend/src/**"])).toBe(true);
    expect(matchesAllow("frontend/src/X.tsx", ["frontend/src/**"])).toBe(true);
    expect(matchesAllow("backend/main.rs", ["frontend/src/**"])).toBe(false);
    expect(matchesAllow("frontend/index.html", ["frontend/src/**"])).toBe(false);
  });
  it("partitions changed paths", () => {
    const { allowed, blocked } = partitionChanges(
      ["frontend/src/App.tsx", "backend/Cargo.toml", "Makefile"],
      ["frontend/src/**"],
    );
    expect(allowed).toEqual(["frontend/src/App.tsx"]);
    expect(blocked).toEqual(["backend/Cargo.toml", "Makefile"]);
  });
});
```
Run `npx vitest run src/guardrails/guardrails.test.ts` → FAIL.

- [ ] **Step 2: Implement** (`guardrails.ts`)
```ts
/** Minimal glob: ** = any depth, * = within a path segment. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (glob[i] === "*") re += "[^/]*";
    else re += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
export function matchesAllow(path: string, allow: string[]): boolean {
  return allow.some((g) => globToRegExp(g).test(path));
}
export function partitionChanges(paths: string[], allow: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [], blocked: string[] = [];
  for (const p of paths) (matchesAllow(p, allow) ? allowed : blocked).push(p);
  return { allowed, blocked };
}
```
Run the test → PASS.

- [ ] **Step 3: Commit**
```bash
git add tweaklet/src/guardrails/guardrails.ts tweaklet/src/guardrails/guardrails.test.ts
git commit -m "feat(tweaklet): guardrails — partition changed paths by allow-globs"
```

---

### Task 5: Server — mode param, agent invocation, Stop endpoint, post-run sweep

**Files:** Modify `tweaklet/src/server/server.ts`; modify `tweaklet/src/server/agent-routes.test.ts`.

> **RESOLVED INVOCATION (Task 1 finding — overrides the draft below):** `--agent <custom>` + `--dangerously-skip-permissions` **hangs** headless, and `--agent build` without the flag won't edit. So:
> - **explore:** `["run","--dir",cwd,"--agent","explore","--format","json","-m",model,"--",prompt]` (NO flag).
> - **build:** `["run","--dir",cwd,"--dangerously-skip-permissions","--format","json","-m",model,"--", BUILD_RULES + "\n\n" + prompt]` (NO `--agent`; prepend a short UI-only/explain-why `BUILD_RULES` prefix; the **post-run sweep is the hard UI-only guardrail**).
>
> Wire it together: the agent route reads `mode` (`explore`|`build`, default `build`), builds the per-mode args above, passes an `AbortSignal`, and after the run computes the blocked set via the guardrails module, reporting it on the stream (no auto-revert). `POST /api/agent/stop` aborts the current run. Update the argv assertions in Step 1 to match the per-mode args.

- [ ] **Step 1: Failing tests** — in `agent-routes.test.ts`, update the argv assertion + add mode/stop tests:
```ts
// argv now includes --agent and NO --dangerously-skip-permissions:
expect(captured.args).toEqual(["run", "--dir", "/tmp/app", "--agent", "build", "--format", "json", "-m", "google-vertex-ai/gemini-2.5-flash", "--", "hello"]);
```
```ts
it("passes --agent explore when mode=explore", async () => {
  // POST /api/agent/prompt { prompt:"hi", mode:"explore" } with a session + captured runAgent
  // expect captured.args to include "--agent","explore"
});
it("POST /api/agent/stop aborts the run", async () => {
  // with a session, expect 200/204 and that the in-flight run's AbortController was aborted
});
```
(Build these against the existing harness in this file: the injected `runAgent` spy + session-cookie helper. For the stop test, make the injected `runAgent` hang on a never-resolving promise that rejects/returns when its `signal` aborts, then call `/api/agent/stop` and assert it resolves.)
Run `npx vitest run src/server/agent-routes.test.ts` → FAIL.

- [ ] **Step 2: Implement** — in `server.ts` agent route:
  - Read mode: `const mode = req.body?.mode === "explore" ? "explore" : "build";`
  - Replace the args (drop `--dangerously-skip-permissions`, add `--agent`):
```ts
        args: ["run", "--dir", config.agent.cwd, "--agent", mode, "--format", "json", "-m", config.agent.model, "--", prompt],
```
  - Create/track an AbortController for the run at module/closure scope:
```ts
  let currentAbort: AbortController | null = null;
```
  and in the route, before `runAgent`: `currentAbort = new AbortController();` pass `signal: currentAbort.signal`; in `finally`, `currentAbort = null;`.
  - Add the stop route:
```ts
  app.post("/api/agent/stop", authGate, (_req, res) => {
    if (currentAbort) { currentAbort.abort(); res.status(202).json({ stopping: true }); }
    else res.status(409).json({ error: "no agent run in progress" });
  });
```
  - After `runAgent` resolves (before/with the `end` event), run the sweep:
```ts
      const changed = await repoLib.changedPaths(config.repo!.path); // see Task 5b
      const { blocked } = partitionChanges(changed, config.guardrails.allow);
      if (blocked.length) send({ type: "guardrail", blocked, raw: {} } as any);
```
  (Import `partitionChanges` from `../guardrails/guardrails.js`.)
Run the tests → PASS. Run `npx vitest run src/server/server.test.ts` → still green.

- [ ] **Step 2b: Add `changedPaths` to `git/repo.ts`** (+ a test): a function returning `git -C <repo> status --porcelain` paths (parsed). TDD it in `git/repo.test.ts` with an injected exec returning sample porcelain output; assert it parses ` M frontend/src/A.tsx\n?? B.txt` → `["frontend/src/A.tsx","B.txt"]`.

- [ ] **Step 3: Build + commit**
```bash
cd /Users/joseph/Projects/transcenda/t8a/tweaklet && npm run build && npm test
cd /Users/joseph/Projects/transcenda/t8a
git add tweaklet/src/server/server.ts tweaklet/src/server/agent-routes.test.ts tweaklet/src/git/repo.ts tweaklet/src/git/repo.test.ts
git commit -m "feat(tweaklet): agent route mode (--agent), stop endpoint, post-run guardrail sweep"
```

---

### Task 6: Web API — mode param + stop()

**Files:** Modify `tweaklet/web/src/api.ts`; modify `tweaklet/web/src/api.test.ts`.

- [ ] **Step 1: Failing test** — `streamPrompt` sends `mode`; `api.stop()` posts to `/api/agent/stop`:
```ts
it("streamPrompt posts the mode", async () => {
  const body = new ReadableStream<Uint8Array>({ start(c){ c.enqueue(new TextEncoder().encode('data: {"type":"end","code":0}\n\n')); c.close(); } });
  const f = vi.fn(async () => ({ ok: true, status: 200, body } as unknown as Response));
  vi.stubGlobal("fetch", f);
  await streamPrompt("hi", "explore", () => {});
  expect(JSON.parse((f.mock.calls[0][1] as any).body)).toEqual({ prompt: "hi", mode: "explore" });
});
it("stop() posts to /api/agent/stop", async () => {
  const f = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) } as Response));
  vi.stubGlobal("fetch", f);
  await api.stop();
  expect(f.mock.calls[0][0]).toBe("/api/agent/stop");
});
```
Run `cd tweaklet/web && npx vitest run src/api.test.ts` → FAIL.

- [ ] **Step 2: Implement** — change `streamPrompt(prompt, onEvent)` → `streamPrompt(prompt, mode, onEvent)`, send `{ prompt, mode }`; add `stop: () => post<void>("/api/agent/stop")` to `api`. Update the other `streamPrompt` call sites + tests to pass a mode. Run → PASS.

- [ ] **Step 3: Commit**
```bash
git add tweaklet/web/src/api.ts tweaklet/web/src/api.test.ts
git commit -m "feat(tweaklet/web): streamPrompt mode param + api.stop()"
```

---

### Task 7: Panel — Explore/Build toggle, Stop button, guardrail notice

**Files:** Modify `tweaklet/web/src/Panel.tsx`, `tweaklet/web/src/panel.css`, `tweaklet/web/src/Panel.test.tsx`.

- [ ] **Step 1: Failing tests** — add to `Panel.test.tsx`:
```ts
it("has an Explore/Build mode toggle and sends the selected mode", async () => {
  streamPrompt.mockResolvedValue({ type: "end", code: 0 });
  render(<Panel />);
  await screen.findByText(/alice/i);
  fireEvent.click(screen.getByRole("button", { name: /explore/i }));
  fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "how does login work" } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => expect(streamPrompt).toHaveBeenCalledWith("how does login work", "explore", expect.any(Function)));
});
it("shows a Stop button while the agent is working", async () => {
  let release: () => void = () => {};
  streamPrompt.mockImplementation(() => new Promise((r) => { release = () => r({ type: "end", code: 0 }); }));
  apiMock.stop.mockResolvedValue(undefined);
  render(<Panel />);
  await screen.findByText(/alice/i);
  fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  const stop = await screen.findByRole("button", { name: /stop/i });
  fireEvent.click(stop);
  expect(apiMock.stop).toHaveBeenCalled();
  release();
});
```
(Add `stop: vi.fn()` to the hoisted `apiMock`; default `apiMock.stop.mockResolvedValue(undefined)` in `beforeEach`.)
Run → FAIL.

- [ ] **Step 2: Implement** in `Panel.tsx`:
  - State: `const [mode, setMode] = useState<"build" | "explore">("build");`
  - A toggle in the header/flow row: two buttons "Build" / "Explore" (aria-labels "Build"/"Explore"), highlighting the active one, calling `setMode`.
  - `send()` → `streamPrompt(text, mode, (e) => push(toRow(e)))`.
  - While `busy`, render a **Stop** button (`aria-label="Stop"`) near the run indicator → `onClick={() => api.stop()}`.
  - Handle a `guardrail` event in `toRow`: render an `apz-note`-style warning row "⚠ N change(s) outside the UI zone were not applied: …" (these are reported, not auto-applied). 
  Add minimal CSS (`.apz-modes`, `.apz-mode.is-active`, `.apz-stop`) to `panel.css`.
Run → PASS. Then `npm run build && npm test` (web) green.

- [ ] **Step 3: Commit**
```bash
git add tweaklet/web/src/Panel.tsx tweaklet/web/src/panel.css tweaklet/web/src/Panel.test.tsx
git commit -m "feat(tweaklet/web): Explore/Build toggle, Stop button, guardrail notice"
```

---

### Task 8: End-to-end verification (operator + Playwright)

- [ ] **Step 1:** `cd tweaklet && npm run build:all`, restart `node dist/index.js serve`, hard-reload the panel.
- [ ] **Step 2 (Explore):** toggle **Explore**, ask "how does the login page work?" → it explains, edits nothing (`git status` clean).
- [ ] **Step 3 (Build, in-bounds):** toggle **Build**, ask for a visible UI tweak under `frontend/src/**` → it edits, streams, change appears live.
- [ ] **Step 4 (Build, out-of-bounds):** ask for a data-model/backend change → the agent **declines and explains why** (delegate to dev team); `git status` shows no backend change.
- [ ] **Step 5 (Stop):** start a longer prompt, click **Stop** → run ends promptly; `git status` only shows in-bounds partial edits (if any).
- [ ] **Step 6:** confirm the full gate is green and everything pushed to `main`.

---

## Self-Review

**Spec coverage:** Modes §1 → Tasks 1,5,6,7. Guardrails §2 (permission-first + explain-why + sweep) → Tasks 1 (agent files = hard layer + explain prompt), 4 (partition), 5 (sweep report). Drop skip-permissions §1/§5 → Tasks 1,5. Stop §3 → Tasks 3,5,6,7. (Memory/cost §4, setup §5, self-healing widget §6 are **Phase 2/3** — out of scope here.) Confirm-before-discard: Phase 1 *reports* blocked changes (no auto-revert); the explicit discard action lands with the sweep UX in Phase 2 — noted, not a gap for the safety guarantee since blocked edits are already prevented at the tool layer.

**Placeholder scan:** none — code is complete; Task 8 is the explicitly-manual operator E2E. Task 5b references `changedPaths` defined in that same task.

**Type consistency:** `streamPrompt(prompt, mode, onEvent)` is consistent across Tasks 6 & 7; `partitionChanges(paths, allow)` matches Task 4 ↔ Task 5; `guardrails.allow` matches Task 2 ↔ Task 5; the `mode` values `"explore"|"build"` match the agent filenames in Task 1.
