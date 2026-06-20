# tweaklet — Agent Control & Safety design

> Status: approved design (2026-06-14). Sub-project: **tweaklet** (self-hosted AI sandbox). Trunk-based: lands on `main`.

## Goal
Make tweaklet safe to hand to **non-technical users** (PMs, designers). The agent must be useful for prototyping yet **incapable** of damaging the system. Three capabilities: **two modes** (Explore/Build), **hard guardrails**, a **kill switch**, plus **session memory + steering** and a **feature cost meter**.

## ⚠ Architecture update (2026-06-15) — opencode SERVER API + interactive approval (supersedes the §1–§3 mechanism)

**Why:** verified empirically that opencode v1.17.4 **hangs headless** on path-scoped (glob) `edit` permissions via `opencode run` — in agent frontmatter or `opencode.json`, any order, with/without `--dangerously-skip-permissions`. The "hang" is opencode **waiting for an interactive permission approval** that the one-shot `run` CLI has no channel to receive. Only whole-tool scalar permissions work via `run` (which is why Explore read-only works).

**The fix (the proper model, not a workaround):** drive the **opencode server** instead of `run`, via the official **`@opencode-ai/sdk`**, and **answer permission requests programmatically** — Cursor-style. This makes path-scoped permissions enforce **at the tool level, before any edit**, and unlocks sessions/memory, steering, per-action approval, and token/cost telemetry from one API.

**Mechanism:**
- tweaklet starts/owns a local opencode server (`createOpencode()` or `opencode serve`; SDK `createOpencodeClient`).
- Per prompt: `session.create` (once per idea → persisted memory) / reuse the id; `session.prompt({ agent: "build"|"explore", parts })`.
- `event.subscribe()` SSE → forward text/tool/step events to the panel; accumulate token/cost.
- **Permission handler** (`POST /session/:id/permissions/:permissionID`) decides each request — this IS the guardrail:
  - in-bounds edit (matches `guardrails.allow`, via `partitionChanges`) → **auto-approve**;
  - out-of-bounds edit → **auto-deny** (hard, tool-level — the edit never happens);
  - risky/ambiguous (shell command, etc.) → **ask the user** in the panel (Allow/Deny), then respond + resume. *(Approval model chosen 2026-06-15: "smart auto + ask only when risky".)*
- **Stop** = the server's session-abort endpoint. **Steering** = send another prompt to the same live session.

**Supersedes:** the post-run **sweep/revert** (no longer needed — out-of-bounds is blocked before it happens). §1 modes still hold (now selected via the `agent` field). The `guardrails` module + config carry over (now powering the approval decision, not a sweep). Phase-1 run-based pieces (`runner.ts` spawn of `opencode run`, the sweep in the agent route) are replaced by the server-client + permission handler.

---

## Key enabling fact
opencode has first-class **primary agents** with **per-agent, path-scoped permissions**, and it **removes denied tools from the model's toolset entirely** (verified: a read-only agent literally had no write tool). So both modes and the UI-only boundary are *hard, tool-level* guarantees — not prompt-hopes. We **drop `--dangerously-skip-permissions`** (currently we run fully unrestricted) and replace it with a per-agent permission matrix.

## 1. Two modes (opencode primary agents, shipped at setup)
Defined as project files the developer installs (`<repo>/.opencode/agent/*.md`, `mode: primary`):
- **Explore** — `permission: { edit: deny, write: deny, bash: deny, webfetch: ask }`. Read-only: explains how features work, traces the code, ideates. opencode strips edit/write tools → cannot change anything, ever.
- **Build** — `edit` glob-scoped to the configured UI paths (`{ "<ui globs>": "allow", "*": "deny" }`), `bash` scoped (`npm`/typecheck/test allow; `git push`, `rm`, file moves outside UI → deny/ask). Creates UI features + drafts a PR.

tweaklet invokes `opencode run --agent explore|build -s <session> ...`. The panel gets a clear **Explore / Build** toggle; the active mode is always visible.

## 2. Guardrails (permission-first)
- **Hard layer:** out-of-bounds edits are **blocked at the tool level** (opencode refuses paths outside the allow-globs). Because blocked edits *never happen*, there is nothing to revert and **no user work is lost**.
- **Explain layer:** a prose rule in the Build agent prompt + `AGENTS.md` instructs the agent that when a request needs non-UI work (data model, migrations, jobs, infra, backend behavior, CI/build), it must **decline and explain to the user, in plain language, why** ("that needs a backend/data change — outside what I can do here; hand it to your dev team"), rather than silently failing.
- **Safety-net sweep:** after each run, tweaklet diffs the repo for anything that slipped outside the allow-set (e.g. a file a `bash` command created). If found, it **shows the user the list and asks for explicit confirmation before discarding** — never auto-deletes (honors "don't lose sensitive changes").
- **Gate:** checkpoint/PR only ever stage allowed paths.
- **Config-driven:** the allow-globs are **project-specific, set during developer setup** (default examples documented). They feed both the Build agent's `edit` permission and the AGENTS.md map.

Net effect: a PM **cannot** alter the data model, migrations, background jobs, CI/CD, build pipelines, infra, or existing backend behavior. Worst case is a declined request with an explanation.

## 3. Stop / kill switch
An `AbortController` per run; `POST /api/agent/stop` kills the `opencode` child process immediately and ends the SSE. The panel shows a **Stop** control whenever the agent works. The safety-net sweep still runs on partial output, so an interrupted run stays safe.

## 4. Sessions, memory, steering, cost
- **Memory:** capture opencode's `sessionID` from the JSON stream, **persist it per idea/branch**, and pass `-s <id>` on subsequent prompts so the agent **remembers prior context** and features can evolve across turns.
- **Compaction:** rely on opencode's built-in **auto-compaction** (`compaction.auto = true`) — we do *not* build our own.
- **Steering:** Stop → re-prompt the same session with a correction (live mid-run steering deferred).
- **Cost meter:** `step_finish` events expose `tokens` + `cost`. tweaklet accumulates these per idea and shows the **total cost of the feature so far** in the panel (e.g. "$0.42 · 38k tokens"), so users see what a feature costs them.

## 5. Project setup (developer-driven, mostly via AI skills)
Most of setup is **not manual config** — it's the developer prompting their own AI agent (e.g. Claude Code), packaged as **tweaklet setup skills**, with the developer reviewing/approving the output:
1. **Configure UI allow-globs + install the Explore/Build agent files + permission matrix** (drop `--dangerously-skip-permissions`) — a skill infers these from the repo's structure; the developer confirms.
2. **Create/review `AGENTS.md`** — a skill drafts it from the codebase (architecture/where-things-live map, best practices to follow, conventions, recommended skills / skill-framework); the developer reviews and fills gaps. Single biggest output-quality lever.
3. *(Optional)* enable opencode **LSP** for the UI stack (TS) for typecheck feedback.
4. Add the widget `<script>` + set `VITE_TWEAKLET_URL` for the deployed environment.
5. **Test & confirm (offered to the developer):** a guided self-test — `tweaklet doctor` (connections) **plus a setup verification** confirming Explore is read-only, Build edits only the allowed UI paths and is blocked outside them, the widget loads, and a sample prompt works end-to-end. The developer explicitly confirms everything works **before** handing the panel to non-technical users.

## 6. Widget robustness
- The injected snippet is **self-healing**: a `MutationObserver` re-injects the launcher/iframe if the host SPA ever removes them, so the panel is "always loaded."
- The guardrails (UI-only) prevent the agent from ever editing the host's `index.html` / build files / tweaklet itself — which is what made the widget vanish during testing.

## Non-goals / deferred
Live mid-run steering; a custom code index/graph (opencode's grep/glob/read + LSP suffice); MCP "query data via API" tool (a strong later add for data dashboards); multi-user concurrency on one instance. **Deployment topology / self-collision is not addressed here — tweaklet will be split into its own repository**, which removes the dogfood caveat entirely.

## Build sequence
1. **Modes + hard guardrails + Stop** (safety core): Explore/Build agents, permission matrix, drop skip-permissions, mode toggle, Stop button, safety-net sweep with confirm.
2. **Memory + cost meter + stop-redirect**: session persistence (`-s`), per-feature cost accumulation + meter, self-healing widget.
3. **Setup + leverage**: skill-driven setup flow (paths, AGENTS.md, agents) + test-and-confirm; LSP enable. MCP data tool later.

## Testing
- Guardrail: Explore agent has no write tool (out-of-bounds edit impossible); Build edits inside allow-globs succeed, outside are blocked; safety-net sweep detects + confirms.
- Stop: abort kills the child + ends the stream; sweep runs on partial output.
- Memory: `sessionID` captured + passed; second prompt recalls prior context.
- Cost: token/cost accumulated across a session.
- Modes: panel toggle selects `--agent`; mode visible.
