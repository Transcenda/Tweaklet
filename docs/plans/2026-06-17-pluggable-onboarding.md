# Tweaklet Phase-1 — Pluggable Mount + Onboarding — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Spec: `tweaklet/docs/specs/2026-06-17-pluggable-onboarding-design.md` (read first).

**Goal:** Mount Tweaklet under a configurable URI prefix (default `/tweaklet`) on any origin; serve the widget from the backend; add a repo allowlist + gh clone; build a resumable web Setup Wizard (guided distro-aware deps → OAuth → Vertex → repo → login); decouple from t8a.

**Workflow:** feature branch `feat/tweaklet-pluggable-onboarding` → PR (Tweaklet is NOT trunk-based as of 2026-06-17). Gate per task: `cd tweaklet && npm run build && npm test` + `npm --prefix web run build && npm --prefix web test`.

**Tech:** Node/TS ESM (Express, zod), Vite/React panel. All in `tweaklet/`.

## DO NOT (every task)
- No commits to `main`; work on the branch. No `--no-verify`, no force-push.
- Don't break existing agent/VCS endpoints — they move under the prefix but keep their behavior.
- No t8a-specific hardcoding (paths, domains, `VITE_TWEAKLET_URL`).

---

### Task 1: URI-prefix mount (server + client base wiring)
**Files:** `tweaklet/src/config/config.ts`, `tweaklet/src/server/server.ts`, `tweaklet/src/index.ts`, `tweaklet/web/src/api.ts`, `tweaklet/web/src/Panel.tsx`, the snippet (in `server.ts`).

- [ ] Add `server.basePath: z.string().default("/tweaklet")` to the config schema (normalize: leading slash, no trailing slash).
- [ ] In `createServer`, mount the whole app under `basePath` — create an Express `Router`, register all current routes on it (rename the API group from `/api/*` → `/agent/*`, and `/snippet.js` → `/widget.js`), then `app.use(basePath, router)`. Health/`/` can stay at root.
- [ ] OAuth `redirectUri = ${config.server.publicUrl}${basePath}/auth/callback`; internal redirects (`res.redirect("/panel/")`) become `${basePath}/panel/`.
- [ ] **`widget.js`** (the former snippet IIFE): derive `base` from `document.currentScript.src` (strip trailing `/widget.js`); build the launcher + iframe `src = base + "/panel"`; all postMessage origin checks use `new URL(base).origin`. No hardcoded `:4319`/origin.
- [ ] **Panel base injection:** when serving the panel HTML, inject `<script>window.__TWEAKLET_BASE__="${basePath}"</script>` (or compute from `location.pathname` stripping `/panel`). In `web/src/api.ts`, read `window.__TWEAKLET_BASE__` (fallback `""`) and prefix every fetch path (`/agent/...`, `/auth/...`). `streamPrompt` likewise.
- [ ] Tests: server test — every route resolves under a custom `basePath` (e.g. `/tw`) and 404s at root; OAuth redirect string includes `publicUrl+basePath`. Web test — `api.ts` prefixes calls with `__TWEAKLET_BASE__`.
- [ ] Commit: `feat(tweaklet): mount under configurable URI prefix (widget.js + base-aware panel/api)`.

---

### Task 2: Repo allowlist + gh clone + doctor extensions
**Files:** `tweaklet/src/config/config.ts`, `tweaklet/src/git/*` (or a new `repo/clone.ts`), `tweaklet/src/doctor/doctor.ts`.

- [ ] Config: `repo.allowlist: z.array(z.string()).default([])` (entries `owner/name` or git URL), `repo.sourceDir: z.string()` (where clones live).
- [ ] `cloneAllowedRepo(repoRef, sourceDir)`: **validate `repoRef` is in `allowlist` (server-side) — reject otherwise**; `gh repo clone <ref> <sourceDir>/<name>`; checkout `baseBranch`; return the checkout path (→ becomes `repo.path`). Idempotent (if already cloned, fetch/checkout).
- [ ] Extend `doctor.ts` checks: **node version** (>= min), **git** present, **distro detection** (parse `/etc/os-release` → `{id, install_hint}` so the wizard can show `apt`/`dnf` commands), **publicUrl reachable** (best-effort). Keep the existing opencode/model/vertex/gh/repo checks. Each check returns `{name, status, detail, fix}` (+ optional `installCommand` for the deps step).
- [ ] Tests: allowlist rejects a non-listed repo; doctor returns the new checks with sane status; distro parse handles debian/ubuntu/fedora + missing file.
- [ ] Commit: `feat(tweaklet): repo allowlist + gh clone + extended doctor (node/distro/publicUrl)`.

---

### Task 3: Setup endpoints (resumable, lock-after-complete)
**Files:** `tweaklet/src/server/server.ts` (or a `setup/routes.ts`), `tweaklet/src/config/config.ts`.

- [ ] Config: `setup.completed: z.boolean().default(false)`.
- [ ] Endpoints under `basePath`, **only mounted/active while `setup.completed === false`** (once true, they 404/410 — setup can't be re-run):
  - `GET /setup/state` → `{ completed, checks: <full doctor result>, steps: [{id, label, status}], firstIncompleteStepId }`.
  - `POST /setup/github` `{clientId, clientSecret}` → validate + save to config.github.
  - `POST /setup/agent` `{vertexProject, vertexLocation, model, command?}` → save to config.agent; run an opencode smoke check.
  - `POST /setup/repo` `{repoRef, guardrailsAllow?}` → `cloneAllowedRepo` + set `repo.path`/`guardrails.allow`.
  - `POST /setup/doctor` → re-run all checks, return fresh state.
  - `POST /setup/complete` → only succeeds when all required steps green + a github session exists; sets `setup.completed=true`, persists, locks the endpoints.
- [ ] Tests: state reflects config gaps; posting github/agent/repo advances the right step; non-allowlisted repo rejected; once `completed`, the setup endpoints are gone; `complete` refused while any required check is red.
- [ ] Commit: `feat(tweaklet): setup endpoints — resumable, locked after completion`.

---

### Task 4: SetupWizard frontend
**Files:** `tweaklet/web/src/SetupWizard.tsx` (new), `tweaklet/web/src/api.ts`, the widget entry that chooses Panel-vs-Wizard.

- [ ] On load, the widget calls `GET /setup/state`. If `completed===false` → render `<SetupWizard>`; else `<Panel>`.
- [ ] `SetupWizard`: fetches full state up-front, renders ALL steps with per-step green/red + detail, expands the first incomplete one but lets the user act on any. Steps:
  - **Dependencies**: for each failing tool, show the distro-specific `installCommand` (copyable) + a **Re-check** button (`POST /setup/doctor`).
  - **GitHub OAuth**: instructions + the exact callback URL to copy (`<base>/auth/callback`, derived from `__TWEAKLET_BASE__` + origin) + client id/secret inputs → `POST /setup/github` → re-check.
  - **Vertex/agent**: project/location/model inputs → `POST /setup/agent` → re-check.
  - **Repository**: dropdown from the allowlist + optional guardrail path → `POST /setup/repo` → re-check.
  - **Finish**: when all green, "Sign in with GitHub" (the existing `/auth/login`), then `POST /setup/complete` once signed in → reloads into the Panel.
- [ ] Tests (vitest/jsdom): wizard shows when `completed:false`; renders per-step statuses from a mocked state; Dependencies shows the install command for a failing check; advances on a successful POST; hidden when `completed:true`.
- [ ] Commit: `feat(tweaklet): resumable web Setup Wizard`.

---

### Task 5: Decouple from t8a + install docs + final gate + PR
**Files:** `tweaklet/docs/INSTALL.md` (new), remove t8a embed coupling.

- [ ] `INSTALL.md`: the irreducible bootstrap (Node LTS, clone, `npm i && npm run build`, `serve`), exposing `<basePath>/*` (Caddy path-handle + nginx location snippets), and the Vertex SA note (grant `aiplatform.user`; ambient ADC on GCP). State that the rest is the in-browser wizard.
- [ ] Decouple: `guardrails.allow` has no hard default tied to t8a (the wizard sets it per repo; keep a sensible generic fallback or none); confirm no `frontend/src/**`/t8a path is baked into code (only as a user-set value). The t8a-side `frontend/index.html` loader is out of scope (host-app concern) — note it.
- [ ] Full gate: `cd tweaklet && npm run build && npm test && npm --prefix web run build && npm --prefix web test` — all green.
- [ ] Commit: `docs(tweaklet): install guide + decouple guardrails from t8a`.
- [ ] Push the branch; open a PR (`gh pr create`) summarizing Phase 1.

## Final verification (controller)
- Final review subagent over the diff (focus: base-path correctness across server+client; setup-endpoint lock; allowlist enforcement).
- Manual smoke locally: start with a non-default `basePath`, load the widget, confirm the wizard renders and a re-check works.
