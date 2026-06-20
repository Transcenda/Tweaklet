# Tweaklet — Closed-Loop Live Editing: Preview + Agent Self-Verification + Crash-Safe Recovery (design)

**Status:** approved direction (2026-06-19) · **implementation deferred** — multi-system (t8a frontend + nexus-dev infra + Tweaklet wizard + a new MCP server + agent config). Review this + the plan first.
**Relates to:** per-user OAuth (`2026-06-18`, shipped), in-app embed + wizard verify (`#85`, shipped), session booking + GitHub App (`2026-06-19-session-booking-model`). This is the "make the loop real, let the agent *see* its work, and survive the agent breaking the app" piece.
**Revision note (2026-06-19):** extends the original live-preview/E2E direction with two pillars agreed in brainstorming — (a) the agent **self-verifies** a change rendered, via a **widget-backed DOM-inspect MCP**; (b) the loop is **crash-safe** (server-side history + recovery when the agent breaks the very app its UI is embedded in).

## Vision — the definition of "the loop works"

A non-technical user types a tweak and, end-to-end:
1. **Sees it live** — the edit appears in the running app they're looking at (not a static build).
2. **The agent confirms it actually rendered** — the agent inspects the live DOM and reports truthfully ("'Hello World' is now in the header"), or self-corrects — it never claims success it didn't verify.
3. **Can always recover** — if an edit breaks the frontend, the user still reaches the (server-side, unaffected) agent to revert/fix, and the conversation history is intact throughout.
4. **Resets cleanly** — one click back to `baseBranch`.

"Green" must mean "the whole loop actually works here," including the failure paths.

## The architectural crux

"See the change live" requires **the viewed app to be served from the agent's working tree.** nexus-dev currently serves t8a as a **static built `:dev` image**, so an agent edit to the clone never appears. **Decision:** on the dev environment, serve the t8a **frontend via `vite dev` (HMR) on the agent's cloned working tree**, behind Caddy; the backend stays the existing container. The guardrail is already `frontend/src/**` — exactly what `vite dev` HMRs. **Per-env: on in dev, off in prod** (prod keeps the static image + no widget).

## Architecture (dev environment)

```
Caddy (nexus-dev.transcenda.com)
  /tweaklet/*  → Tweaklet server      (:4319)   — wizard + agent + widget.js + MCP endpoint
  /api/*       → t8a backend container (:8080)   — Rust/Axum (unchanged, built image)
  /            → vite dev server       (:5173)   — t8a FRONTEND served from the agent's
                                                    clone (repo.path/frontend), HMR on,
                                                    proxying /api → :8080
```
- The t8a **frontend** is served live from `repo.path/frontend` by `vite dev`; the agent edits `frontend/src/**` → HMR → the developer (viewing `/`) sees it instantly.
- The **backend** stays the deployed container (agent doesn't touch backend code; guardrail = frontend only).
- The **widget** is embedded by the host loader (below), riding on top of the live-served frontend.

## Host-app integration — GA-style snippet (shipped in #85)

Tweaklet embeds via a drop-in `<script src="/tweaklet/widget.js"></script>` (relative path → self-derives its base; works behind any proxy). The developer installs it (their repo / CI), optionally via the bundled `install-tweaklet-widget` Claude Code Skill. Per-env: committed to `main`, gated on for the dev build, inert in prod (Tweaklet isn't deployed there → the script 404s harmlessly). For t8a the stale `frontend/index.html` loader was already replaced (#85).

## Pillar A — Agent self-verification via a widget-backed DOM-inspect MCP

The agent must be able to **fetch the rendered DOM by CSS selector and confirm its change appeared** — and report honestly when it didn't. Mechanism (chosen in brainstorming):

- **Delivery = MCP, surfaced as tool calls.** Tweaklet hosts a **remote MCP server** (part of its own Node process, e.g. `…/tweaklet/mcp`). opencode connects to it via the **global `opencode.json` Tweaklet already auto-writes** (the same file that carries the Vertex provider config) — zero host-repo pollution, no `.opencode/tool/` file injected into the user's clone. Chosen over a CLI/raw-API (the agent would reach those only through `bash`, which is `bash:ask` → a permission prompt per inspection) and over an opencode native project-tool (would pollute the clone + still need a hop to reach the widget).
- **Backend = the widget reading *your* live page (not a headless browser).** Because the panel runs in the host page via an open Shadow root (no iframe), it can read the live rendered DOM. The MCP tool handler — running **in Tweaklet's process, which already holds the widget's SSE connection** — publishes an inspect request to the active widget, the widget runs `document.querySelector(sel)` and returns `{exists, outerHTML, text, computedStyle}`, the handler resolves and returns it to the agent. This **reuses the exact round-trip pattern already built for permission prompts** (`pendingAsks` map + a widget POST). No Chromium on the (tight 4 GB) VM; the agent sees precisely what the user sees, post-HMR.
- **Toolset (start small):** `dom_query(selector)` → matched element's `{exists, outerHTML, text, computedStyle}`; `dom_query_all(selector)` → count + summaries. Defer `dom_screenshot` until needed.
- **Agent must-verify rule.** `assistant.md` (and/or a bundled verify-skill doc) instructs the agent: after a visual change, call the DOM tools to confirm the element/text actually rendered **before reporting done**; if it can't confirm, say so and fix — never claim a visual success it didn't verify. Same principle as the setup smoke-test, now in the agent's normal loop.

**Constraints:** the user's browser must be open on a relevant route (a header check works anywhere; a route-specific element needs the user on that route — acceptable, they're viewing the app while tweaking). One active widget (fits the booking model: one holder → one page → one DOM source).

## Pillar B — Crash-safe history + recovery

The widget is embedded in the very app the agent edits, so a bad edit can white-screen the frontend and take the panel down with it. Resilience is structural:

- **Server is the source of truth; the widget is a disposable view.** opencode persists each session's message/tool history to disk and exposes it (`GET /session/{id}/message`) — **verified across restarts (v1.17.8)** — so Tweaklet relies on the built-in store and keeps only a **durable holder→sessionId→branch mapping** (not just an in-memory `Map`). The widget never holds the only copy; re-hydration replays the session's messages. No custom event log needed.
- **Re-hydrate on every (re)load.** On mount — embedded *or* standalone — the panel calls a Tweaklet endpoint that reads the session from opencode and replays the full activity log + branch state. A reload (including crash-induced) restores the conversation mid-task.
- **The agent is server-side and unaffected.** opencode runs in Tweaklet's process on the VM; a broken host frontend can't touch it — the agent is always alive to fix/revert. Only the user's *channel* is at risk.
- **A crash-proof channel: the standalone `/tweaklet/` panel.** Served by Tweaklet's own Node server, independent of the (broken) `vite dev` frontend. With the host app white-screened, the user opens `/tweaklet/`, history re-hydrates, and they tell the agent "undo / fix it."
- **The embedded widget may survive too.** It mounts in its own Shadow root (not inside the host React tree), so a host-app *runtime* crash doesn't necessarily kill it — it can show its own "the app errored — revert last change?" affordance. The standalone panel is the guaranteed fallback.
- **Recovery completes itself.** Agent reverts/fixes `frontend/src` → HMR recompiles → host app renders again → embedded widget returns and re-hydrates. An **always-available "revert last change → baseBranch"** control (existing discard/undo) is reachable from the resilient channel the whole time.

## Tweaklet wizard — guided E2E finalization

The final wizard phase becomes a re-checkable guided round-trip; Finish gated on all passing:
1. **Embed live** — host app serves the widget (`/` returns the loader + `/tweaklet/widget.js` loads). Offers "open in the app" as soon as true. *(shipped, #85)*
2. **Agent reachable as you** — a signed-in trivial prompt round-trips under the user's token. *(shipped, #85 smoke-test)*
3. **Hello-world (sees it)** — one-click: the agent adds a visible "Hello World" to the header on a throwaway branch and **confirms it via `dom_query` (the same MCP path)** — proving live preview + self-verification together.
4. **Reset** — one-click revert to `baseBranch`; confirm clean.
5. **Finish** — enabled only once 1–4 pass.

## Components

- **Tweaklet — DOM-inspect MCP server (new):** a remote MCP endpoint in the Tweaklet process exposing `dom_query`/`dom_query_all`; tool handlers round-trip to the active widget via the existing SSE + pending-request machinery. Added to the auto-written global `opencode.json` so the `assistant` agent picks it up.
- **Tweaklet — widget DOM bridge (new):** the widget answers inspect requests over its SSE channel (`document.querySelector` → `{exists, outerHTML, text, computedStyle}`), reusing the element-picker's host-DOM access.
- **Tweaklet — agent verify-rule (new):** `assistant.md` / bundled verify-skill text: verify visual changes via DOM tools before reporting done.
- **Tweaklet — durable history + re-hydration (new):** persist holder→session→branch; a `GET …/agent/history` (or similar) that replays a session's events; widget re-hydrates on mount; standalone `/tweaklet/` as the recovery channel; "revert last change" always reachable.
- **nexus-dev infra (dev module / startup):** install the t8a frontend's npm deps on the VM; a `t8a-frontend-dev` systemd unit running `vite dev` on `repo.path/frontend` (started once a repo is cloned, (re)started on clone/handover); Caddy `/`→`:5173` (dev only, flag-gated), `/api`→`:8080`, `/tweaklet`→`:4319`. Prod unchanged (static image, no widget, no HMR).
- **t8a (consumer):** GA-style snippet already in `frontend/index.html`, gated on for the dev build. *(shipped, #85)*

## Security

- The dev `vite dev` server is exposed behind Caddy on the dev box; the t8a SPA gates on its own login; HMR websocket is dev-only and flag-gated off in prod. The access allowlist (booking spec) gates Tweaklet sign-in.
- Per-user token handling unchanged (in-memory, `GIT_ASKPASS`, purge on release).
- DOM-inspect is **read-only** (no DOM mutation from the agent side) and scoped to the active holder's widget. The MCP endpoint is local (Tweaklet process) and only serves the authenticated session.
- The hello-world E2E writes only within `frontend/src/**` (guardrail) on a throwaway branch, then resets.

## Resolved during design (verified 2026-06-19 on nexus-dev)

- **opencode session durability → use the built-in.** opencode 1.17.8 persists sessions to disk and exposes full history via `GET /session` + `GET /session/{id}/message` — verified by listing sessions and replaying messages created *before* today's many opencode restarts. Tweaklet relies on opencode for history and keeps only a **durable holder→sessionId→branch mapping**; re-hydration = fetch the session's messages and render them. No custom event log (the less-desirable path) needed.
- **VM resources → no bump needed now.** Measured on the running VM: **2.9 GiB available** of 3.8 + **2 GiB unused swap**, full stack live (opencode ~421 MB the largest). A Vite dev server is ~0.3–0.7 GB → fits with ~2 GB to spare. Revisit only if headroom shrinks; not a blocker.
- **MCP transport → supported, build it.** opencode 1.17.8 ships first-class MCP (`opencode mcp`). Tweaklet hosts a remote MCP server and registers it in the auto-written `opencode.json`; the exact remote-config field shape is trivial to confirm against the opencode schema during planning.

## Open questions (settle during planning — impl details, not blockers)

1. **vite dev process model on the VM** — a `t8a-frontend-dev` systemd unit on `repo.path/frontend`; (re)start on clone/handover. One vite-dev bound to the active holder's clone (booking: one holder → one tree → one vite dev).
2. **Backend coupling** — confirm frontend-only live edit; the Vite proxy points `/api`→`:8080`. Backend changes are out of scope (guardrail frontend-only).
3. **Prod parity** — prod serves the static image, widget off, no MCP, no vite dev; confirm the flag-gating cleanly no-ops.

## Risks

- **nexus-dev process complexity** — a long-running `vite dev` (+ node_modules) alongside backend/postgres/tweaklet/opencode on one VM; needs careful lifecycle (systemd unit, (re)start on clone). RAM is fine (verified 2.9 GiB free + 2 GiB swap; vite dev ~0.5 GB) — the risk is process orchestration, not memory.
- **DOM-inspect depends on an open widget on the right route** — mitigated for header/global elements; route-specific checks need the user present (acceptable for the tweak UX).
- **Dev diverges further from prod** (live frontend vs built image) — intended; the per-env flag + Caddy routing must be unambiguous.

## Phasing recommendation

Each phase independently useful; build in order:
- **P1 — Snippet + Skill + embed-verify + agent-readiness smoke-test.** ✅ **Shipped (#85).** Panel embedded, agent works as you, setup verifies a real prompt.
- **P2 — Live preview.** `vite-dev`-on-worktree on the dev env + Caddy routing + the VM lifecycle. Delivers "you see it live." *Foundation for P2.5 — nothing to inspect until the rendered app is the working tree.*
- **P2.5 — Agent self-verification (Pillar A).** The widget-backed DOM-inspect MCP + `assistant.md` must-verify rule. Delivers "the agent sees it / no false claims."
- **P2.6 — Crash-safe history + recovery (Pillar B).** Durable history + re-hydration + the standalone recovery channel + always-available revert. Delivers "survive the agent breaking the app."
- **P3 — Guided hello-world E2E.** The scripted change → see → verify (via P2.5) → reset finish gate.
