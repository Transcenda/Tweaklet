# tweaklet — opencode-server agent layer + interactive permission guardrail

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the `opencode run` subprocess agent layer with the **opencode server** (driven via `@opencode-ai/sdk`), so permissions are answered interactively: in-bounds UI edits auto-approved, out-of-bounds **auto-denied at the tool level (before the edit)**, risky actions surfaced to the user for Allow/Deny. Adds session memory, Stop (abort), steering, and a cost meter.

**Architecture (empirically proven 2026-06-15):** tweaklet owns one opencode server (`createOpencode()` → `{client, server}`; spawns `opencode serve`, so opencode's dir must be on PATH). Per prompt: `client.session.create` (persist id per idea) / reuse; `client.session.prompt({ path:{id}, body:{ model:{providerID:"google-vertex-ai", modelID}, agent:"build"|"explore", parts:[{type:"text",text}] } })`; `client.event.subscribe()` → events `{type, properties}`. On `permission.asked` (`properties: { id, sessionID, permission:"edit"|"bash"|…, patterns:[relpaths], metadata:{filepath,diff} }`) → decide → `client.postSessionIdPermissionsPermissionId({ path:{id:sessionID, permissionID:id}, body:{ response:"once"|"reject" } })`. Stop → `client.session.abort({path:{id}})`. Run ends on `session.idle`.

**Tech Stack:** Node/TS (tweaklet), `@opencode-ai/sdk` (installed), Vitest, Express; React panel.

**Spec:** [`../specs/2026-06-14-tweaklet-agent-control-safety-design.md`](../specs/2026-06-14-tweaklet-agent-control-safety-design.md) (see the 2026-06-15 architecture-update section).

**Supersedes:** `runner.ts` (`opencode run` spawn), `opencode-events.ts` parsing, the run-based agent route, and the post-run sweep — all replaced here. Reuses: `guardrails.ts` (`partitionChanges`/`matchesAllow`), `config.guardrails.allow`, the Explore/Build agent files, the panel shell + auth, the mode toggle + Stop button.

---

### Task 1: Permission decider (pure, guardrail-based)

**Files:** Create `tweaklet/src/agent/decide.ts`, `tweaklet/src/agent/decide.test.ts`.

> Pure function: given a `permission.asked` payload + the allow-globs, return `"approve" | "deny" | "ask"`. Edits inside allow → approve; edits outside → deny; non-edit/risky (bash, etc.) → ask.

- [ ] **Step 1: failing test** (`decide.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import { decidePermission } from "./decide.js";
const allow = ["frontend/src/**"];
describe("decidePermission", () => {
  it("approves edits fully inside the allow-globs", () => {
    expect(decidePermission({ permission: "edit", patterns: ["frontend/src/App.tsx"] }, allow)).toBe("approve");
  });
  it("denies edits outside the allow-globs", () => {
    expect(decidePermission({ permission: "edit", patterns: ["backend/main.rs"] }, allow)).toBe("deny");
  });
  it("denies if ANY requested path is out of bounds", () => {
    expect(decidePermission({ permission: "edit", patterns: ["frontend/src/A.tsx", "Makefile"] }, allow)).toBe("deny");
  });
  it("asks for non-edit actions like bash", () => {
    expect(decidePermission({ permission: "bash", patterns: [] }, allow)).toBe("ask");
  });
  it("asks when no patterns are present (unknown scope)", () => {
    expect(decidePermission({ permission: "edit", patterns: [] }, allow)).toBe("ask");
  });
});
```
Run `cd tweaklet && npx vitest run src/agent/decide.test.ts` → FAIL.

- [ ] **Step 2: implement** (`decide.ts`)
```ts
import { matchesAllow } from "../guardrails/guardrails.js";
export interface PermissionAsked { permission?: string; patterns?: string[]; }
export type Decision = "approve" | "deny" | "ask";
export function decidePermission(p: PermissionAsked, allow: string[]): Decision {
  const kind = (p.permission ?? "").toLowerCase();
  if (kind === "edit" || kind === "write" || kind === "patch") {
    const paths = p.patterns ?? [];
    if (paths.length === 0) return "ask";
    return paths.every((x) => matchesAllow(x, allow)) ? "approve" : "deny";
  }
  return "ask"; // bash, webfetch, etc. — surface to the user
}
```
Run → PASS.

- [ ] **Step 3: commit + push**
```bash
cd /Users/joseph/Projects/transcenda/t8a
git add tweaklet/src/agent/decide.ts tweaklet/src/agent/decide.test.ts
git commit -m "feat(tweaklet): permission decider — approve in-bounds edits, deny out-of-bounds, ask for risky"
git push origin HEAD:main
```

---

### Task 2: opencode-server client module (lifecycle + runPrompt)

**Files:** Create `tweaklet/src/agent/opencode-server.ts`, `tweaklet/src/agent/opencode-server.test.ts`.

> The core. A lazily-started server/client singleton, plus `runPrompt(args)` that drives one prompt: create/reuse session, subscribe, send, handle permissions via an injected `decide` + an `onAsk` async callback (for "ask"), forward events, support abort, resolve on idle. The SDK client is **injected** for testing (no real server in unit tests).

- [ ] **Step 1: define the interface + failing test.** `opencode-server.test.ts` builds a FAKE client: `session.create` → `{data:{id:"ses_x"}}`; `event.subscribe` → an async iterable you push events into; `postSessionIdPermissionsPermissionId` → records calls; `session.prompt` → resolves after you emit a `session.idle`; `session.abort` → records. Test that:
  - a `permission.asked` with an in-bounds edit → decider "approve" → `postSessionIdPermissionsPermissionId` called with `body.response==="once"`;
  - out-of-bounds → `response==="reject"`;
  - a "bash" permission → `onAsk` is invoked and its resolved value ("approve"→once / "deny"→reject) is sent;
  - `message.part.updated` text events are forwarded to `onEvent`;
  - `abort()` (via signal) calls `client.session.abort`.
  (Write these as separate `it()`s; drive the fake event stream + assert.)

- [ ] **Step 2: implement** (`opencode-server.ts`)
```ts
import { decidePermission, type Decision } from "./decide.js";

export interface RunPromptArgs {
  client: any;                 // @opencode-ai/sdk client (injected)
  sessionId?: string;          // reuse for memory; else created
  mode: "build" | "explore";
  model: string;               // "google-vertex-ai/gemini-2.5-flash"
  prompt: string;
  allow: string[];             // guardrails.allow
  onEvent: (e: any) => void;   // forward to the SSE/panel
  onAsk: (req: { permissionID: string; permission: string; patterns: string[]; diff?: string }) => Promise<"approve" | "deny">;
  signal?: AbortSignal;
}
export interface RunPromptResult { sessionId: string; blocked: string[]; }

export async function runPrompt(a: RunPromptArgs): Promise<RunPromptResult> {
  const [providerID, modelID] = a.model.includes("/") ? [a.model.split("/")[0], a.model.split("/").slice(1).join("/")] : ["", a.model];
  let sessionId = a.sessionId;
  if (!sessionId) { const s = await a.client.session.create({ body: { title: "tweaklet" } }); sessionId = s.data?.id ?? s.id; }
  const blocked: string[] = [];
  const events = await a.client.event.subscribe();
  let done = false;
  if (a.signal) a.signal.addEventListener("abort", () => { a.client.session.abort({ path: { id: sessionId } }).catch(() => {}); }, { once: true });

  const pump = (async () => {
    for await (const ev of events.stream) {
      if (done) break;
      const t = ev.type, p = ev.properties ?? {};
      if (p.sessionID && p.sessionID !== sessionId) continue; // other sessions
      if (t === "permission.asked") {
        const decision: Decision = decidePermission(p, a.allow);
        let response: "once" | "reject";
        if (decision === "approve") response = "once";
        else if (decision === "deny") { response = "reject"; blocked.push(...(p.patterns ?? [])); }
        else { const r = await a.onAsk({ permissionID: p.id, permission: p.permission, patterns: p.patterns ?? [], diff: p.metadata?.diff }); response = r === "approve" ? "once" : "reject"; }
        await a.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: p.id }, body: { response } }).catch(() => {});
      } else if (t === "session.idle") { done = true; break; }
      else if (t === "session.error") { a.onEvent({ type: "error", message: JSON.stringify(p).slice(0, 300), raw: p }); }
      else { a.onEvent({ type: t, raw: p }); } // message.part.updated etc. → panel maps these
    }
  })();

  await a.client.session.prompt({ path: { id: sessionId }, body: { model: { providerID, modelID }, agent: a.mode, parts: [{ type: "text", text: a.prompt }] } }).catch(() => {});
  done = true;
  await Promise.race([pump, new Promise((r) => setTimeout(r, 500))]);
  return { sessionId: sessionId!, blocked };
}

// server singleton (real, not used in unit tests)
let _oc: { client: any; server: any } | null = null;
export async function getServer(): Promise<{ client: any; server: any }> {
  if (_oc) return _oc;
  const { createOpencode } = await import("@opencode-ai/sdk");
  _oc = await createOpencode();
  return _oc;
}
export async function stopServer(): Promise<void> { try { _oc?.server?.close?.(); } catch {} _oc = null; }
```
Run the tests (with the fake client) → PASS. (Map the panel's existing event shapes in Task 4 — here we just forward `{type, raw}`.)

- [ ] **Step 3: commit + push** (`opencode-server.ts` + test).

---

### Task 3: server route rewrite — use runPrompt + ask round-trip + session + stop

**Files:** Modify `tweaklet/src/server/server.ts`; modify `tweaklet/src/server/agent-routes.test.ts`.

- [ ] **Step 1:** ensure opencode's dir is on the server process PATH so `createOpencode` can spawn `opencode serve`: in `serve` startup (index.ts) or when building the client, prepend `dirname(config.agent.command)` to `process.env.PATH` if `config.agent.command` is absolute. (Add a tiny test or just wire it.)
- [ ] **Step 2:** Rewrite `POST /api/agent/prompt`: read `mode`; keep a per-server `Map<sessionKey,sessionId>` (key by the user login + current idea/branch) for memory; call `runPrompt({ client: (await getServer()).client, sessionId, mode, model: config.agent.model, prompt, allow: config.guardrails.allow, onEvent: send, onAsk, signal })`. `onAsk` creates a pending promise stored in a `Map<permissionID, resolve>`, emits `send({type:"permission_ask", permissionID, permission, patterns, diff})`, and awaits resolution. Persist the returned `sessionId`. Keep the `{type:"end", code}` final frame; include `blocked` as a `guardrail` event if non-empty.
- [ ] **Step 3:** Add `POST /api/agent/permission` (authGate) `{ permissionID, response: "approve"|"deny" }` → resolves the pending promise for that id (404 if none).
- [ ] **Step 4:** `POST /api/agent/stop` → abort the current run (signal) → which calls `session.abort`.
- [ ] **Step 5:** update `agent-routes.test.ts` (inject a fake `getServer`/client via `deps`, or refactor `runPrompt` injection) so the route is testable without a real server; assert: prompt forwards events, an in-bounds permission auto-approves, `/api/agent/permission` resolves an ask, `/api/agent/stop` aborts. Build + test green. Commit + push.

> Note: this removes the `runAgent`/`parseOpencodeLine` usage from the route. Leave the old files for now (delete in Task 6) to keep diffs reviewable.

---

### Task 4: web API + panel — approval UI, cost, session

**Files:** Modify `tweaklet/web/src/api.ts`, `tweaklet/web/src/Panel.tsx`, `tweaklet/web/src/panel.css` + their tests.

- [ ] **Step 1 (api):** add `respondPermission(permissionID, response)` → POST `/api/agent/permission`. `streamPrompt` already sends `mode`. Tests.
- [ ] **Step 2 (panel — approval):** handle a `permission_ask` SSE event → render an **approval card** in the stream: the action (e.g. "Run command" / "Edit outside the UI"), the `diff`/command in a `<pre>`, and **Allow / Deny** buttons → `api.respondPermission(id, "approve"|"deny")`; the card resolves to a note after answering. Tests (a `permission_ask` event renders Allow/Deny; clicking posts the response).
- [ ] **Step 3 (panel — cost):** accumulate token/cost from `step`/`message` events (`properties.tokens`, `.cost`) and show a small **"$X · Yk tokens"** meter in the header. Test the accumulation.
- [ ] **Step 4 (panel — guardrail note):** keep the existing `guardrail` blocked-notice handling.
- [ ] **Step 5:** build + test (web) green. Commit + push.

---

### Task 5: server lifecycle + Stop wiring + retire dead code

**Files:** `tweaklet/src/index.ts` (serve), delete `tweaklet/src/agent/runner.ts` + `runner.test.ts` + `opencode-events.ts` + `opencode-events.test.ts` if now unused; update imports.

- [ ] **Step 1:** on `tweaklet serve` startup, eagerly `getServer()` (warm the opencode server) and register `stopServer()` on SIGINT/SIGTERM. On shutdown, also abort any active session.
- [ ] **Step 2:** grep for remaining imports of `runner`/`parseOpencodeLine`/the sweep; remove the now-dead modules + their tests. Build + full test suite green.
- [ ] **Step 3:** commit + push.

---

### Task 6: End-to-end verification (Playwright + real opencode server)

- [ ] `npm run build:all`; restart `tweaklet serve` (warms the opencode server). Hard-reload the panel.
- [ ] **Explore:** ask "how does login work?" → explains, no changes.
- [ ] **Build in-bounds:** ask for a `frontend/src/**` tweak → in-bounds edits auto-approve (no prompt), change appears live.
- [ ] **Build out-of-bounds:** ask for a backend/data change → the edit is **auto-denied at the tool level**; the agent explains it can't; `git status` shows no backend change.
- [ ] **Ask flow:** trigger a bash action → an **Allow/Deny approval card** appears in the panel; Deny → blocked; Allow → proceeds.
- [ ] **Stop:** start a longer run, hit Stop → aborts promptly.
- [ ] **Memory:** a follow-up prompt references the prior one → the agent remembers (same session). Cost meter increments.
- [ ] Confirm full gate green + pushed to `main`.

---

## Self-Review
**Spec coverage:** server-API pivot → Tasks 2,3,5. Smart-approval (in-bounds approve / out-of-bounds deny / risky ask) → Tasks 1 (decide), 2 (runPrompt), 3 (ask round-trip), 4 (panel approval). Sessions/memory → Tasks 2,3,4. Stop → Tasks 2,3,5. Cost meter → Task 4. Explore read-only → already (agent file) + Task 6 verify. Retire run+sweep → Task 5.
**Placeholder scan:** none — code complete; Task 6 is the explicit manual E2E.
**Type consistency:** `runPrompt`/`RunPromptArgs` (Task 2) consumed by Task 3; `decidePermission(p, allow)` matches Task 1↔2; `permission_ask` event shape matches Task 3 (emit) ↔ Task 4 (render); `respondPermission` matches Task 4 (api) ↔ Task 3 (endpoint).
