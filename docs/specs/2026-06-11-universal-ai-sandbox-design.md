# tweaklet — v1 Design

> Status: **approved — proceeding to implementation plan** · revised 2026-06-12 · standalone product
> incubation (not a T8A module).
> Companion research: [`2026-06-11-universal-ai-sandbox-landscape.md`](./2026-06-11-universal-ai-sandbox-landscape.md).
> Name: **tweaklet** (working name).
>
> **Terminology:** the box tweaklet runs on is the **Dev Server** (often a repurposed QA server).
> The business that installs and owns it is the **company**.

---

## 1. What it is

> **The open-source, self-hosted AI prototyping layer for your existing apps — non-technical
> teammates prompt a live instance of your app and carry a real feature all the way to a merged
> GitHub PR, without a line of your code ever leaving your infrastructure.**

A non-technical teammate (PM, designer, QA) opens a running instance of a real app on the Dev
Server, describes a feature in plain language, watches an AI agent make the change live, opens a
GitHub PR under their own identity, and iterates it — through code review — to merge.

## 2. The differentiator (the wedge)

Every close competitor (Lovable, v0, Builder.io Fusion, Replit, Devin) is a **SaaS where your
code runs on their cloud.** tweaklet is the opposite:

- **Open source**, pulled into the company's own environment.
- **Self-hosted** — runs on infrastructure the company already has, behind its firewall.
- **The company's source code never leaves its network.**
- **Bring your own model** — Vertex AI / Bedrock / any endpoint; **no vendor lock-in, no new billing.**
- **Compliance-native** — the company's access controls, data boundary, and audit trail.

The landscape research confirms the `{run an arbitrary existing app} + {non-technical live-app
prompting} + {PR-to-merge}` combination is unoccupied — and *nobody* offers it air-gapped/OSS.

## 3. Mental model

**The company's Dev Server becomes a developer's machine, operated by an AI agent, prompted by
non-technical people.** The Dev Server already runs the full app (backend + DB + services) with
realistic data — so tweaklet inherits the running full-stack environment for free. The "developer"
driving it is the agent (Gemini CLI); the agent is driven by non-technical prompts.

Corollary: the agent's capability ceiling is a developer's. v1 steers non-technical users toward
**frontend / user-facing features** as a **guardrail/UX choice, not a limit** — widening scope
later is relaxing guardrails, not re-platforming.

## 4. The leanest v1 — runs on infrastructure you already have

The decisive simplification: **don't provision anything. Install tweaklet onto the company's
existing Dev Server** (a non-prod box — frequently a repurposed QA server). That box already solves
the four things that were eating v1 scope:

| Concern | Who solves it in v1 |
|---|---|
| Runtime + dependencies | the Dev Server (the app already runs there) |
| Isolation boundary | the Dev Server (it's already a non-prod box) |
| TLS / ingress / networking | the Dev Server's existing infra — **tweaklet ships none of it** |
| Realistic data | the Dev Server's existing data — **no seed generation** |

So v1 ships **zero infrastructure**: no VM provisioning, no Docker/Compose, no reverse proxy, no
TLS handling, no seed-data pipeline. tweaklet is a service installed on the box + a thin web UI.

### The v1 flow
existing Dev Server → install tweaklet → **setup wizard** (run by a developer) → non-technical user
prompts in the panel → **Gemini CLI** edits code on the server → app updates live → user iterates →
**"Ready to go prod"** opens a draft GitHub PR under the user's identity → user keeps prompting to
refine and to address review feedback → merge.

## 5. Personas & the guiding principle

- **Developer** — installs tweaklet on the Dev Server and runs the wizard; **also defines the
  architecture notes, guardrails, custom skills, and agent instructions** that make the agent code
  well (§6.1 step 8); reviews and merges the PRs.
- **Non-technical contributor** (PM/designer/QA) — prompts the live app, ships features, and carries
  them through review to merge.

> **Guiding principle: everyone ships production features through the same pipeline.** A PM's
> feature and a staff engineer's feature both arrive as a reviewed PR into the real delivery flow.
> User-facing copy stays production-oriented; "Dev Server"/"sandbox" is infra language, never copy a
> contributor reads.

## 6. Architecture (v1)

### 6.1 Install + the setup wizard (developer, one-time)
tweaklet installs as a service on the Dev Server and exposes a thin web UI. A developer runs a
one-time wizard that configures the critical options:

1. **Target & OS user** — confirm the server; choose the **Linux user the agent runs as**; verify
   that user can clone and run the app.
2. **Connect GitHub** — tweaklet needs a GitHub **OAuth App registered on the company's own GitHub**
   (github.com org *or* their GitHub Enterprise Server). This can be fiddly, so the wizard **guides
   it explicitly**: shows the exact callback URL to paste, deep-links GitHub's *New OAuth App* page,
   and takes back `client_id` / `client_secret`. (Why per-company: §6.5.)
3. **Authorize** — "Sign in with GitHub" → OAuth token with `repo` scope.
4. **Clone** — clone the repo **under the agent user's home directory**.
5. **Branch model** — base branch (`main`/`develop`) + branch-naming convention matching the
   company's existing standard (e.g. T8A's `<type>/<linear-id>-<slug>`) + PR target.
6. **Run & live-update** — the run/build command (e.g. `make dev`, `npm run dev`, a binary build) +
   **how the running app picks up a change**: native hot-reload if the app has it, otherwise
   **rebuild-and-swap** (rebuild the bundle/binary, then symlink or copy it over the running app).
   tweaklet must support configuring all of these — see §6.4. **We do not assume hot-reload exists.**
7. **Agent credentials** — point the agent at the company's **Vertex AI** (`GOOGLE_CLOUD_PROJECT`,
   or inherit the server's `gcloud` auth). **Default: the developer provisions these**, and the
   wizard includes a **"test the agent connection"** step (a throwaway prompt that must succeed).
   End-user-provisioned credentials are a documented alternative but discouraged — they require
   infra knowledge a non-technical user won't have.
8. **Agent guidance (quality)** — the wizard walks the developer through **authoring / verifying the
   agent's context**: architecture notes, guardrails, custom skills, and agent instructions, surfaced
   via **`AGENTS.md`** (and the agent's native context file, e.g. `GEMINI.md`) so skills are
   discoverable. tweaklet ships scaffolding and sensible defaults but does **not** hard-bake one
   framework — the company chooses its best-practices/skills framework (pluggable). *This is the
   single biggest lever on whether the agent finishes features well — see §6.2.*
9. **Panel delivery & test** — choose how the agent panel reaches users: a **JS snippet** injected
   into the app (for SPAs) **or** a **standalone agent-chat browser tab** (for server-rendered /
   multi-page apps). The developer **runs one real change end-to-end** to confirm the loop works.

Output: a single local **config file in the agent user's home directory** (repo, OS user, branch
model, run/live-update command, agent project, panel mode), read by both the app integration and
the agent. **No database, no control plane in v1.**

### 6.2 The Agent — drive an OSS harness (opencode) on the company's Vertex AI
**tweaklet does not build an agent harness — it drives an existing open-source one, behind a
config-driven seam (`runAgent`).** v1 uses **opencode** (the most actively-developed OSS agentic
CLI of 2026, ~150K★; provider-agnostic via models.dev): it runs headless, edits files autonomously,
and streams structured JSON events that drive the panel's progress.

> **Why not Gemini CLI:** Google **deprecated Gemini CLI (sunset 2026-06-18)** in favor of
> "Antigravity CLI" — building on it was a dead end. opencode is fully OSS, model-agnostic, and
> *lighter* than the alternatives (no mandatory Docker sandbox), which fits tweaklet's
> run-directly-on-the-Dev-Server model. **OpenHands** is the documented heavier fallback
> (autonomous/sandboxed, but pulls in a Docker runtime) if opencode ever disappoints.

**Verified working on the company's Vertex Gemini** (key-less via ADC, no new billing) — a real
prompt drove an autonomous file edit end-to-end:
- Config `~/.config/opencode/opencode.json`: provider `google-vertex-ai` with
  **`"npm": "@ai-sdk/google-vertex"`** + `options:{project, location:"global"}` + a models entry
  (opencode auto-installs the native Vertex SDK and authenticates via ADC).
- Invocation: `opencode run --dir <repo> --format json --dangerously-skip-permissions -m
  google-vertex-ai/<model> -- "<prompt>"`, env `GOOGLE_CLOUD_PROJECT` + `VERTEX_LOCATION=global`.
  **`--dir` is essential** — without it opencode roams to an ancestor repo and edits the wrong files
  (caught in verification). `--` guards the prompt against argv flag-smuggling. v1's isolation
  boundary is the disposable non-prod Dev Server; stronger per-instance isolation is Phase 2.
- Real event schema (for the normalizer): `step_start` → `text` (assistant; `part.text`) →
  `tool_use` → `tool` (`{tool, callID, state:{status,input,output}}`) → `file` →
  `step_finish` (`{reason, tokens, cost}`); plus `error`.

- **Quality is the harness's + the model's** — what tweaklet builds is **orchestration + UI + the
  git/PR lifecycle**, not an agent. What makes it *finish features* well is context: the
  developer-authored guardrails/skills (§6.1 step 8) + run/test access + the iterate loop.
- **Model is independently swappable** — opencode is model-agnostic, so a company can point it at a
  stronger model (e.g. **Claude on Vertex**, once enabled in Model Garden) via one config line, no
  harness change. **Model quality is the lever that decides whether developers accept the PRs.**

### 6.3 The Overlay UI — a single right panel
App gets the full screen; tweaklet is a **slim, collapsible right panel**, delivered as a **JS
snippet** (SPA) or a **standalone tab** (server-rendered/MPA) per §6.1 step 9:
- **Agent chat** — the prompt; the agent narrates *code exploration* in plain language so the user
  never reads code.
- **Cursor-like progress** — driven by opencode's `--format json` events (`step_start`/`text`/`tool`/`step_finish`) — what it's editing/running.
- **Compact git/build controls** — **deterministic `git`/`gh` shells, not agent-mediated**:

| Control | Under the hood |
|---|---|
| Start a new idea | branch from base, auto-named per convention |
| Refresh app | the configured live-update (hot-reload or rebuild-and-swap) |
| Save checkpoint | commit |
| Undo | reset to last checkpoint / discard |
| Ready to go prod | `gh pr create` (draft) |

**Full feature lifecycle — including post-PR flows (in-panel):**
idea → (agent) explore → draft → see it live → **Ready to go prod** (draft PR) → **push follow-up
commits** to refine → **surface PR review comments** and prompt the agent to address reviewer
requests → push fixes → **merged**. Post-PR is mostly `gh` (e.g. `gh pr view`/`gh pr checks`) + the
agent, so it's light to build — but the panel must carry the feature all the way to merge, not stop
at PR creation.

### 6.4 Live update (configurable — no HMR assumption)
The mechanism is **chosen at setup (§6.1 step 6)** because legacy apps vary:
- **Native hot-reload** if the app has it (e.g. Vite HMR, `nodemon`) — fastest.
- **Rebuild-and-swap** otherwise — rebuild the bundle/binary, then **symlink or copy** it over the
  running app, and restart/reload as configured.

No custom containers, no swap *engine* — tweaklet runs the company's configured commands.

### 6.5 Identity & authorization — per-company GitHub OAuth, app-level only
**GitHub OAuth is the only login, and the only thing tweaklet secures.** One token (with `repo`
scope) powers login + clone + `gh` CLI + PR creation. **Authorization comes for free: if GitHub says
you can access the repo, you can prototype on it.**

**Each install registers its own OAuth App on the company's own GitHub — required, not just
preferred:** a single shared `client_id` would route auth through a redirect URI *the vendor* hosts
(breaking the air-gap) and **wouldn't work at all for GitHub Enterprise Server** customers.
Per-company registration keeps everything inside the company's boundary. Because this step is the
fiddliest part of a fresh install, **the wizard guides it explicitly** (§6.1 step 2). (A published
GitHub *App* on the Marketplace is a possible future convenience for github.com-hosted companies,
but it phones home and doesn't cover GHES — so per-company stays the default.)

**tweaklet handles no transport security.** It runs as a service on the Dev Server and gates its own
endpoints behind GitHub auth; TLS, ingress, and networking are whatever the Dev Server already
provides. v1 checks *authorization*, nothing else.

## 7. v1 simplifications (explicit)
1. **Runs on the existing Dev Server** — no VM, no provisioning.
2. **No Docker/Compose** — run the app the way the company already does, via a configured command.
3. **Reuse the Dev Server's data** — no seed generation; **Dev API backdoor → Phase 2.**
4. **Drive an OSS agent harness (Gemini CLI), don't build one** — Vertex-auth, headless-streamable;
   pluggable backend.
5. **No transport/TLS/infra** — app-level GitHub auth only; the Dev Server fronts everything.
6. **Single right panel** — JS snippet (SPA) or standalone tab (MPA); panel drives Gemini CLI's stream.
7. **No per-user isolation** — one shared working copy, one session at a time. **Multiple users →
   one Dev Server per user** (Phase 2), not multi-tenant on one box.
8. **Config is one local file in the agent user's home dir** — no database, no control plane.
9. **PR refinement *and* post-PR review flows are native** — `gh` + the agent carry the feature to merge.

## 8. v1 vs Phase 2

| | v1 — on the company's existing Dev Server | Phase 2 — scale & isolate |
|---|---|---|
| Runtime | the app's own run command on the Dev Server | Docker/Compose, per-instance |
| Provisioning | none (reuse the Dev Server) | spin a Dev Server / instance **per user** (k8s or VMs) |
| Isolation | the Dev Server itself | Kata/gVisor, per-user instances |
| TLS / ingress | the Dev Server's existing infra | Caddy/Traefik, per-subdomain TLS |
| Data | reuse Dev Server data | Dev API (reset/seed/impersonate) + synthetic-data generation |
| Agent | Gemini CLI on Vertex | + Claude-on-Vertex / OpenHands / Aider adapters |
| Identity | per-company GitHub OAuth, app-level | + GitLab/Bitbucket, richer roles |
| Editing | prompt → agent | + visual point-&-click (Onlook) |
| Concurrency | one session at a time | many users (one Dev Server each) |

## 9. End-to-end journey (v1)
1. **Dev installs** tweaklet on the existing T8A **Dev Server** and runs the wizard: picks the agent
   OS user, registers a GitHub OAuth App on the Transcenda GitHub, clones under the user's home dir,
   sets the branch model, sets `make dev` + the live-update strategy, points the agent at Vertex and
   **tests the connection**, authors/verifies `AGENTS.md` + guardrails + skills, chooses the **SPA JS
   snippet**, and **runs one real change** to confirm the loop.
2. **A PM** signs in with GitHub, lands in tweaklet: T8A running, slim panel on the right.
3. PM: *"Make the prompt-editing box on the recruitment settings page bigger."* Gemini CLI explores,
   edits, the app updates live; the PM watches progress stream in the panel.
4. PM iterates, saves a checkpoint, clicks **Ready to go prod**.
5. tweaklet branches/commits/pushes as the PM and opens a **draft PR**. A reviewer comments; the PM
   prompts the agent to address the comments; fixes push to the same PR; it merges.

## 10. Open questions & risks
- **PR quality** (the field's hardest unsolved problem): mitigations — best available model on
  Vertex; **developer-authored guardrails/skills via `AGENTS.md`** (§6.1 step 8) are the main lever;
  PR is a **draft** for review, never auto-merge; refine-by-prompting + address-review-by-prompting.
- **Shared-Dev-Server collisions** — v1 is single-session; two simultaneous prototypers on one box
  collide. Acceptable for proof; per-user Dev Servers is the headline Phase-2 feature.
- **Live-update varies by app** — must be configured at setup (hot-reload or rebuild-and-swap); the
  developer owns getting it working and testing it.
- **Per-company OAuth App setup** is the fiddliest install step — mitigated by an explicit guided wizard.

## 11. OSS / tooling stack (v1)
Existing Dev Server (no Docker, no VM) · **opencode** (OSS, provider-agnostic) driving **Vertex AI / GCP** Gemini via ADC ·
`git` + **`gh` CLI** · **GitHub OAuth** (per-company OAuth App, app-level auth) · configurable
live-update (native hot-reload **or** rebuild-and-swap) · React right-panel UI as JS snippet (SPA)
or standalone tab (MPA) · one local config file in the agent user's home dir · **`AGENTS.md`** +
company-chosen skills/best-practices framework.

## 12. Open decisions
- **Repo home:** incubating on `spike/ai-sandbox` in the T8A repo; separate repo when it graduates.
- **First demo feature (chosen):** enlarge the prompt-editing textarea on the recruitment settings
  page — a deliberately tiny, low-risk frontend change to prove the loop end-to-end.
