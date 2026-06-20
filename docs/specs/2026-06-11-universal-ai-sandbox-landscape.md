# Universal AI Sandbox — Competitive & Technology Landscape

> Research compiled 2026-06-11 to inform the brainstorm for a "universal AI sandbox" —
> a product that (eventually) auto-containerizes any existing/legacy app (app + DB +
> dependent services + a git clone), runs it as a spinnable isolated environment, bakes
> in an AI agent that **non-technical** users prompt via a web UI (overlay on the live
> app or a separate tab), and lets them **"ask for a PR"** to hand prototyped code to devs.
>
> Sourced via web research (multiple agents). Every non-obvious claim carries a source URL.
> **Pricing and product status are point-in-time (June 2026) — re-verify before quoting.**
> This is a *standalone product* being incubated; T8A is dogfood app #1. These docs will
> migrate to the product's own repo once it exists.

---

## TL;DR for the brainstorm

**No single product does all three pillars** — `{A} auto-containerize an arbitrary legacy
app incl. DB + services` + `{B} non-technical prompting on the LIVE running app` + `{C}
clean PR handoff`. The market splits cleanly, and each contender nails two pillars while
being structurally blocked on the third — almost always blocked on **A**.

- **C (PR handoff + edit-existing-repo)** is crowded, mature, well-funded (Devin, OpenAI
  Codex cloud, GitHub Copilot agent, Cursor, Claude Code, Jules, Factory.ai @ $1.5B) — but
  **developer-facing**, executing in **headless/code-centric** sandboxes, not a live
  full-stack app a non-coder drives visually.
- **B that builds an app** is owned by Lovable-style builders — but they're **greenfield**
  (can't import an arbitrary legacy stack) and provision a **fixed managed backend**
  (Supabase/Firebase), not your app's real DB + services.
- **"Edit the live running app" visually** is Builder.io Fusion, Onlook, Plasmic — but
  **frontend-only** (React/Next/Vue); they don't run your backend/DB.
- **Auto-containerizing a legacy runtime (A)** is the domain of CDEs (Codespaces, Coder)
  and legacy-modernization tools (AWS Transform, watsonx Code Assistant for Z) — but CDEs
  **require developer-authored config** (no auto-detection) and modernization tools
  **rewrite code**, they don't stand up a live sandbox for non-technical prompting.

**Closest single product to the full vision: [Builder.io Fusion](https://www.builder.io/fusion)**
(visual + AI + existing GitHub repo + `@builder-bot` PR) — but **frontend-only**, doesn't
run your backend/DB. **The intersection {A + B} is genuinely unoccupied**, mostly for
*technical* reasons (see "Why hasn't this been done"), not lack of interest.

---

## The three-pillar map

| Pillar | Who does it well | Who does NOT |
|---|---|---|
| **A — auto-containerize an arbitrary legacy app incl. DB + services** | *Nobody fully.* CDEs run existing repos but need dev-authored config; Replit/Firebase Studio run any-framework but provision *greenfield* backends; modernization tools rewrite rather than run; WebVM/CheerpX can boot a Linux box from a Dockerfile in-browser but is single-machine | App builders (greenfield + fixed backend), browser runtimes (no Docker/DB), visual editors (frontend-only) |
| **B — non-technical prompting on the LIVE running app** | Builder.io Fusion, Onlook (frontend); Power Apps Copilot (own runtime); Lovable/v0/Replit (chat, not a true live-app overlay) | All PR-agents (developer-facing, headless); all sandbox infra (no UI); all modernization (enterprise dev tools) |
| **C — "ask for a PR" handoff** | The PR-agents own this; also v0, Tempo, Lovable, Replit, **Builder.io Fusion (@builder-bot)** | Browser runtimes, Bubble (no code), modernization tools (rewrite, not PR-prototype), Power Apps (no repo) |

---

## 1. AI App Builders ("Lovable-style")

Converging on one shape: prompt-to-app generators that **scaffold brand-new** full-stack web
apps (overwhelmingly React/Next + Tailwind) on a **fixed managed backend** (Supabase, Neon,
Firebase, or vendor Postgres), deploy to their own hosting, optional GitHub export. Universal
gap vs the vision: **almost all are greenfield-only and cannot ingest an arbitrary legacy
codebase**; the few that import a repo are framework-locked and bring code but **not the
existing data/secrets/dependent services**.

| Product | Existing repo? | Full-stack/DB | Runtime | PR handoff | Biggest gap |
|---|---|---|---|---|---|
| **Lovable** | Partial (Vite/React scaffold) | Managed Supabase | gVisor via Modal | Two-way GitHub, PRs | Greenfield React scaffold |
| **Bolt.new** | Small/medium JS | DB external | **WebContainers (in-browser WASM)** | Push to GitHub | WASM can't run Docker/native DBs |
| **v0 (Vercel)** | **Yes — any GitHub repo** | Brokered Neon/Supabase | **Firecracker microVM** (Vercel Sandbox) | **In-app PR → main** | Next/React-only; brokered DBs, not your DB+services |
| **Replit Agent (3/4)** | **Yes — any framework** | **Own Postgres** | Linux containers → microVMs | Two-way GitHub | Import doesn't bring legacy data/secrets/deps up *running*; chat not overlay |
| **Firebase Studio** | **Yes — most stacks** | Auto Firestore | **Full GCP Debian VM + Nix** | Publish to new repo | Fresh VM; greenfield Firestore |
| Create.xyz / Softgen / Tempo / a0.dev / Databutton | greenfield or framework-locked | varies (Supabase/Neon) | mostly undisclosed | export or two-way | greenfield generators |
| **Bubble** | N/A (own runtime) | proprietary | own cloud engine | **none (no code export)** | opposite of the vision |

**Pricing:** credit/token/message-metered; "Pro" tiers cluster **$19–$30/mo**, heavy users
$100–$500+. (Lovable $25, Bolt $25, v0 Team $30, Replit Core $20.)

---

## 2. Cloud / Remote Dev Environments (CDEs)

CDEs nail "clone an existing repo and run it isolated in the cloud," but fall short on four
axes: **(1) no auto-detection** of how to run an arbitrary app — every one needs
developer-authored config (`devcontainer.json`, Terraform, `.gitpod.yml`, K8s/compose);
**(2) built for developers** (VS Code/SSH/terminal), no non-technical overlay; **(3)** AI-agent
integration is now dominant but targets developers; **(4)** "handoff" is plain `git push`.

- **GitHub Codespaces** — dev container per repo; **no auto-run** (boots generic image; team
  authors `devcontainer.json`). Full-stack via team-authored `docker-compose`. Compute
  $0.18–$2.88/core-hr.
- **Gitpod Classic → "Ona"** — Classic K8s being **retired** (PAYG sunset Oct 15 2025; Gitpod
  called the K8s arch a "journey of … failures and dead-ends"). Rebranded **Ona**, repositioned
  around **fleets of background agents that "return PRs autonomously"** — closest CDE to "ask
  for a PR," but a developer agent-orchestration platform.
- **Coder (AGPL-3.0 + enterprise)** — self-hosted, workspaces from **Terraform templates the
  platform team writes** (explicitly not auto-detection). Native in-control-plane agent.
- **DevPod (OSS, Loft)** — client-only; notably can **"set up a best-estimate dev environment
  by analyzing your project"** — the *closest thing to auto-detection* (a heuristic baseline,
  not full legacy auto-containerization). No AI.
- **Okteto** — automated **Kubernetes** dev envs; runs `docker-compose` on K8s — but assumes
  the app is *already* compose/K8s-manifested.
- **Codeanywhere** — lightweight browser IDE; pick a prebuilt stack container.

**Takeaway:** the CDE industry, with massive funding, **punted on auto-detecting how to run an
arbitrary app** — they make the developer write config. DevPod's heuristic is the only gesture
toward A. This is the strongest evidence that **A is the hard, unclaimed part.**

---

## 3. AI Sandbox / Code-Execution Infrastructure (the plumbing to build ON)

Solves *safe, isolated, fast code execution for agents* brilliantly (Firecracker/gVisor
microVMs, sub-100ms snapshots/forks) — but every one is **developer/SDK infrastructure, not an
end-user product**: no auto-containerization, no non-technical UI, no PR workflow, **and none
ships its own coding agent** (Fly Sprites is the only one that even pre-installs Claude Code).
You bring the image/code; they run it.

| Product | Isolation tech | Persistence / fork | License | Pricing (≈, Jun 2026) | Note |
|---|---|---|---|---|---|
| **E2B** | **Firecracker microVM** (~80–200ms) | pause/resume (FS+memory); fork = open request | **Apache-2.0** (SDK + self-hostable infra) | $0.05/vCPU-hr, $0.016/GiB-hr | The canonical agent-sandbox primitive |
| **Modal Sandboxes** | **gVisor** (`runsc`) | FS/dir/memory snapshots; clone `_experimental_` | Proprietary SaaS (SDKs Apache-2.0) | ~$0.14/vCPU-hr (sandbox rate) | **Powers Lovable's previews** |
| **Daytona** | Docker/OCI default; **Kata microVM** opt-in | native **fork + fork tree**, indefinite persist | **AGPL-3.0** + hosted | $0.0504/vCPU-hr; $200 free | Pivoted from CDE → agent sandboxes |
| **Fly.io Machines / Sprites** | **Firecracker** | Sprites: checkpoint/restore ~1s, COW, ~100GB | Proprietary (Firecracker OSS) | Sprites $0.07/CPU-hr | **Sprites pre-installs Claude Code/Codex/Gemini** |
| **Cloudflare Sandbox SDK** | per-instance VM (tech unnamed) + DO; **disk ephemeral** | snapshot/fork "rolling out" at GA | **SDK Apache-2.0**; platform proprietary | $0.00002/vCPU-s | Edge model; externalize all state |
| **Northflank** | **Kata/Cloud-Hypervisor microVM** or **gVisor** (adaptive) | persistent volumes + managed DBs; indefinite | Proprietary; **mature BYOC** | $0.01667/vCPU-hr | Most full-stack-capable (runs app+DB+services) |
| **Firecracker** (AWS) | the **microVM** itself (KVM); ~125ms boot, <5MiB | snapshot/restore | **Apache-2.0** | free (self-host) | Substrate under E2B, v0, Fly, Blacksmith |
| **gVisor** (Google) | user-space **syscall-interception** kernel | `runsc` checkpoint/restore | **Apache-2.0** | free (self-host) | Substrate under Modal, Lovable |

**Buy-vs-build verdict:** the isolation/runtime layer is a **commodity** and a clear buy. A
universal AI sandbox almost certainly runs **on** Firecracker or gVisor (via E2B/Modal/Daytona/
Fly/Northflank), not on reinvented microVMs. **Northflank** is the most full-stack-capable
(runs app + DB + services persistently, BYOC); **E2B** is the most permissively licensed
Firecracker option; **Fly Sprites** has the best pause/resume + already bundles agent CLIs.

---

## 4. Browser / In-Process Runtimes — architecturally disqualified for full-stack

Run code *inside the browser tab* (WASM) or a lightweight JS sandbox. Magical for instant
frontend prototyping, but **cannot run a legacy app + its real DB + dependent services**.

- **StackBlitz WebContainers** — in-browser Node; **"Databases, Docker, and non-Node backends
  are not supported."** Powers Bolt.new.
- **Nodebox (CodeSandbox)** — in-browser Node; **"unable to connect to external databases"**
  except via REST.
- **WebVM / CheerpX** — WASM x86 virtualization; runs **unmodified Linux binaries in-browser**,
  and **Mini.WebVM can boot a Linux box from a Dockerfile** — closest in-browser analog to
  containerization, but **single client-side machine**, not orchestrated multi-service.

---

## 5. Autonomous Coding Agents that Open PRs (owns pillar C — and it's crowded)

The **most mature, crowded, well-funded** slice of the landscape — but **overwhelmingly
developer-facing**, executing in **headless/code-centric** sandboxes; **none auto-containerizes
a legacy app's full runtime** (all assume a runnable repo).

- **Devin (Cognition)** — own cloud workspace with Shell/IDE/**Browser/Desktop** tabs; the
  Desktop tab lets you "test your application running on Devin's machine in the browser" —
  *closest to interactive running-app*, but a **developer session UI**; app must be set up
  inside (no auto-containerization). ACU pricing (~$2.25/ACU).
- **OpenAI Codex cloud** — per-task sandbox container, **offline by default**, visual feedback
  is **static screenshots only**. Most headless. Bundled in ChatGPT.
- **Google Jules** — repo → GCP VM → PR; "for devs who ship daily"; async screenshots.
- **GitHub Copilot coding agent** — assign issue → Actions VM → **draft PR**; headless. (NB:
  **Copilot Workspace sunset May 30 2025**; the new **Copilot app**, tech preview May 2026,
  adds isolated workspaces + browser previews — most Workspace-like, still developer-oriented.)
- **Claude Code** — terminal/IDE/Actions/web; locally can **"open your apps, click through your
  UI, and test what it built"** with visual diffs; web runs isolated cloud sandboxes → PRs.
  GitHub Action is **OSS (MIT)**.
- **Cursor cloud agents** — isolated Ubuntu VMs; **Feb 2026 "Computer Use"** gives each agent a
  desktop+browser to start dev servers and click through UI — but a **dev-env for the agent's
  own verification**, not a non-technical surface.
- **OpenHands (OSS, MIT, ~76K★)** — agent in a Docker sandbox; PRs via resolver.
- **Aider (OSS)** — terminal pair-programmer; local commits, **no native PR**.
- **Sweep** — **pivoted** to a JetBrains plugin; old PR bot gone.
- **Factory.ai** — enterprise "Droids"; **$1.5B** (Apr 2026); headless CLI / cloud dev machines.

**Takeaway:** pillar C is **commoditized → integrate, don't invent.** Competing here means
fighting Devin/Copilot/Cursor/Factory. The defensible wedge is **A + B**, not C.

---

## 6. "Edit the Running App" / Visual AI for Existing Apps (closest to pillar B)

Closest to "non-technical prompting overlaid on the running app" — and **Builder.io Fusion is
the single closest product to the overall vision.** But the whole category is **frontend-only**
(React/Next/Vue/Svelte/Angular): they edit and live-preview the UI of an existing repo, map
visual edits back to JSX, and can open PRs — **they do not run the app's backend or database.**

- **Builder.io Fusion / Visual Copilot — CLOSEST TO THE VISION.** "AI-powered visual canvas
  that integrates directly with your **existing codebase**." Targets designers, developers,
  **and PMs**. Connects to any GitHub repo; React/Next/Svelte/Vue/Angular. **PR handoff matches
  the vision's language:** "Create a PR, **tag @builder-bot**, watch the AI respond to feedback,
  fix build failures, and iterate." **Biggest gap: frontend-only** — edits/runs your UI against
  your *existing APIs*, but does **not** auto-containerize and run your backend + DB + services.
- **Onlook (OSS, Apache-2.0)** — "Cursor for Designers"; sits on a **running Next.js + Tailwind**
  project. Loads code into a web container (CodeSandbox SDK + Bun), instruments the bundle with
  **`data-oid` attributes** so a visual edit locates the JSX, patches it, and triggers **HMR** —
  a concrete answer to "map visual edits back to source." Frontend-only.
- **Webstudio (AGPL-3.0)** — visual builder / Webflow alternative; exports Remix/React.
- **Plasmic** — visual builder integrating with your React codebase; frontend-focused.
- **Anima** — Figma-to-code + code injection into existing codebases; frontend-only.
- **Microsoft Power Apps Copilot** — NL-to-app, **non-technical-targeted** and full-stack —
  but **greenfield within Microsoft's proprietary low-code runtime**; can't import an arbitrary
  legacy app; no PR to a code repo.

**Takeaway:** B is real and shipping for the **frontend layer**. The differentiator left open is
running the **full app stack** (real backend + real DB) behind the non-technical surface.

---

## 7. AI-Assisted Legacy Modernization (shares the spirit, solves a different problem)

These **rewrite/refactor legacy code** (COBOL→Java, .NET upgrades, framework migrations) as
**enterprise services/IDE tools for developers**, not a spinnable live sandbox a non-technical
user prompts. Strongest evidence that "legacy + AI" is hot and well-funded — and the strongest
contrast in approach (rewrite-and-prove-equivalence vs run-and-prototype).

- **IBM watsonx Code Assistant for Z** — mainframe COBOL/Java transformation; agentic in 2.8.
- **AWS Transform** — enterprise mainframe/VMware/.NET modernization workbench (App2Container
  closed to new customers after Nov 7 2025).
- **Google Cloud Mainframe Modernization (Gemini)** — MAT / Mainframe Rewrite / **Dual Run**
  (run old + new in parallel and compare — echoes "the running system is the truth").
- **Moderne / OpenRewrite** — deterministic recipe-based mass refactoring across many repos.
- **Mechanical Orchard "Imogen"** — **most philosophically aligned**: data-capture agents on the
  *running* mainframe — **"the running system is a better specification than its code"** — to
  guide AI rewrites with proven equivalence. But a high-touch enterprise rewrite service.

All **enterprise / "contact sales" / services-led** — none self-serve. Legacy modernization is
sold **top-down to enterprises**, not bottom-up to non-technical individuals.

---

## SYNTHESIS

### Who comes closest (and what's missing)

1. **Builder.io Fusion** — B + C + existing repos; **missing A** (frontend-only). *Closest.*
2. **Replit Agent** — A-ish (any-framework cloud Linux + own Postgres) + chat-B + C; but import
   doesn't bring legacy data/secrets/deps up *running*; prompting is chat, not a live-app overlay.
3. **Devin / Cursor (Computer Use) / new Copilot app** — C + a *developer-facing* live-app surface;
   missing the non-technical audience and A.
4. **Lovable / v0** — B + C; greenfield-biased, frontend/serverless backend (missing A).

**The intersection {A + B} is unoccupied.** Every contender nails two pillars and is blocked on
the third — most on **A**.

### Hardest technical problems the field has hit

1. **Auto-containerizing arbitrary/legacy apps — THE unsolved problem.** The whole CDE industry
   punted to dev-authored config; DevPod's heuristic is the only auto-detect attempt. Reliably
   running an *unknown* legacy app (obscure build tooling, OS deps, undocumented service graph,
   a real DB schema + data) is the make-or-break bet — *exactly where everyone else gave up.*
2. **Two audiences want opposite things.** Non-technical users want a forgiving visual surface;
   developers want clean, idiomatic, reviewable PRs. Bridging "PM clicks around a live app" →
   "senior engineer accepts the diff" is an unsolved **quality** problem (visual-editor PRs are
   often non-idiomatic; AI-on-legacy hallucination risk is high).
3. **Realistic data + secrets in a sandbox** is a security/compliance minefield. A faithful clone
   needs production-like data + credentials — what security teams won't let leave prod. Everyone
   who tried (Replit, Codex) carved it out rather than solved it.
4. **Hot-reload of a full-stack app after a non-trivial change** (backend rebuild, DB migration)
   is far harder than frontend HMR — and a slow rebuild loop kills the "prototype live" UX.
5. **Multi-service orchestration** is partially solved where teams already have compose/Helm, but
   *deriving* the service graph for an arbitrary app is unsolved.

### Pricing & positioning patterns

- Per-seat ($10–$40/seat/mo): visual editors, CDEs, agents' base tiers.
- Credits/tokens/messages (Pro ≈ $19–$30, scaling $100–$500): app builders + agents.
- Compute-metered (CPU/RAM/GPU-seconds, per-sandbox-hour): all infra.
- Enterprise "contact sales" / services-led: all modernization, premium CDEs.
- **Likely model for this product: hybrid — per-seat (non-technical UX) + per-sandbox-hour
  (running full-stack compute)** — a warm full-stack sandbox is genuinely expensive.

### Why hasn't this been fully done?

It's the **union of three hard problems, each owned by a different incumbent category** —
*legacy auto-containerization* (enterprise/infra DNA) + *non-technical UX* (app-builder DNA) +
*PR handoff* (dev-tools DNA). No one has had a reason to fuse enterprise-infra DNA with
consumer-UX DNA. **A is genuinely hard and genuinely unclaimed.**

### The 5 closest competitors

| Rank | Product | A (legacy full-stack) | B (non-technical live-app) | C (PR) | Net distance |
|---|---|---|---|---|---|
| 1 | **Builder.io Fusion** | No (frontend-only) | **Yes** | **Yes** | **Closest** — missing full-stack runtime |
| 2 | **Replit Agent** | Partial | Partial (chat) | Yes | Best runtime breadth; weak overlay |
| 3 | **Onlook** (OSS) | No (Next/Tailwind) | **Yes** | Unclear | Strong B + OSS; frontend-only |
| 4 | **Devin** | No | No (dev UI, but interactive app) | **Yes** | Closest *dev* analog |
| 5 | **v0 (Vercel)** | Partial (Firecracker import) | Partial | **Yes** | Good A-substrate + C; greenfield-biased |

---

## Implications for THIS product (as scoped in the brainstorm)

Decisions so far: **non-technical-first**, **assume-it-containerizes for v1** (AI-assisted,
dev-in-the-loop containerization deferred to Phase 2), **frontend-feature edit scope**, **T8A as
dogfood app #1**, **PR handoff in v1 (minimal)**.

1. **The moat is A + B, and we deliberately deferred A.** That's the right *sequencing* (prove
   the value loop cheaply), but it means **v1 must not collapse into "a frontend visual editor"**
   — that space already exists (Builder.io Fusion, Onlook).
2. **v1's differentiation vs Fusion/Onlook = the sandbox runs the WHOLE app** (backend + DB +
   services), so non-technical prototypes run against the **real, live, isolated app + real
   data** — not just against API endpoints. **Full-stack RUNTIME, frontend-scoped EDITS.** Keep
   the full-stack runtime front-and-center even in v1.
3. **Buy the isolation layer.** Build on Firecracker/gVisor via E2B / Northflank / Fly Sprites /
   Daytona. Northflank is the most full-stack-capable; Fly Sprites already bundles agent CLIs +
   best pause/resume. Do **not** reinvent microVMs.
4. **Integrate, don't invent, the PR handoff (C).** It's commoditized. `@builder-bot` is the UX
   pattern to study.
5. **Phase 2 (A) is the real prize and the real risk.** "AI-assisted, dev-in-the-loop
   containerization" is more tractable than the auto-magic version nobody has shipped — but it's
   still the hardest, most differentiating bet. DevPod's project-analysis heuristic and Mechanical
   Orchard's "running system is the spec" are the closest prior art to study.
6. **Plan early for the data/secrets problem** — the recurring wall. A realistic full-stack
   sandbox needs production-like data; that's a security/compliance design problem, not an
   afterthought.
