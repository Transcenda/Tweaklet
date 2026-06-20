# Tweaklet P1 — In-App Embed + Verify (snippet + Skill + wizard checks)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Branch `feat/tweaklet-pluggable-onboarding` (PR #85). Spec: `docs/specs/2026-06-19-inapp-live-preview-and-e2e-finalization-design.md` (P1). Gate: `cd tweaklet && npm run build && npm test` + `npm --prefix web run build && npm --prefix web test`.

**Goal:** Get the Tweaklet panel embedded in the live t8a app on nexus-dev, ship the GA-style install snippet + a Claude Code Skill to install it, and make the wizard **verify the panel is live** (+ the agent is ready as the signed-in user) before Finish.

**Scope of P1:** embed + verify only. **NOT** P1: live preview (vite-dev-on-worktree) and the hello-world E2E — those are P2/P3.

## DO NOT
No commits to `main` directly; no `--no-verify`/force-push. The t8a-side changes (frontend/index.html, Dockerfile, deploy-dev.yml) go on the same branch. Keep `VITE_TWEAKLET_URL` UNSET in prod (`deploy.yml`) so the widget stays off in prod.

---

### Task 1: `install-tweaklet-widget` Claude Code Skill + snippet docs

**Files:** Create `tweaklet/skills/install-tweaklet-widget/SKILL.md`; update `tweaklet/README.md` + `tweaklet/docs/INSTALL.md`.

- [ ] Write `SKILL.md` (frontmatter `name: install-tweaklet-widget`, `description:` triggering on "install/embed the Tweaklet widget in an app"). Body instructs Claude Code to:
  1. Locate the app's entry document — `index.html` (Vite/CRA/static), `app/layout.tsx` or `pages/_document.tsx` (Next), server templates (Rails `application.html.erb`, Django `base.html`), etc.
  2. Insert the GA-style snippet **once** (idempotent — skip if already present), with a **relative** URI:
     ```html
     <!-- Tweaklet AI tweak panel -->
     <script src="/tweaklet/widget.js"></script>
     ```
  3. Apply **per-environment gating** appropriate to the stack: for build-time-env frameworks (Vite/Next), gate the injection behind an env flag (e.g. only when `import.meta.env.VITE_TWEAKLET_URL` / a dev flag is set) so it's **on in dev, off in prod**; for static/no-env setups, document that prod simply doesn't serve `/tweaklet/widget.js` (graceful no-op) or add it only to the dev entry.
  4. Note the reverse-proxy requirement (host must route `/tweaklet/*` → the Tweaklet server).
- [ ] README/INSTALL: add a "Embed the widget" section with the copy-paste snippet (GA-style) + a pointer to the Skill.
- [ ] No tests (doc/skill artifact); verify the SKILL.md frontmatter parses (valid YAML) + the gate still green.
- [ ] Commit `feat(tweaklet): install-tweaklet-widget Claude Code Skill + GA-style snippet docs`.

---

### Task 2: t8a host integration — fix loader + build-arg gating

**Files:** Modify `frontend/index.html`, `Dockerfile`, `.github/workflows/deploy-dev.yml`.

- [ ] `frontend/index.html`: the existing loader requests the removed `/snippet.js`. Change to the self-mounting bundle + a relative base:
  ```js
  const tweakletUrl =
    import.meta.env.VITE_TWEAKLET_URL || (import.meta.env.DEV ? "http://localhost:4319" : "");
  if (tweakletUrl) {
    const s = document.createElement("script");
    s.src = tweakletUrl + "/widget.js";   // was "/snippet.js"
    s.async = true;
    document.head.appendChild(s);
  }
  ```
  (For nexus-dev, `VITE_TWEAKLET_URL=/tweaklet` → `s.src = "/tweaklet/widget.js"`, same-origin.)
- [ ] `Dockerfile`: make the frontend build see the flag. Before `RUN npm --prefix frontend run build`:
  ```dockerfile
  ARG VITE_TWEAKLET_URL=""
  ENV VITE_TWEAKLET_URL=$VITE_TWEAKLET_URL
  ```
  (Default empty → prod build leaves the widget off.)
- [ ] `.github/workflows/deploy-dev.yml`: pass the build-arg so `:dev` turns the widget on. In the docker build/push step add:
  ```yaml
  build-args: |
    VITE_TWEAKLET_URL=/tweaklet
  ```
  (Prod `deploy.yml` is NOT changed → no build-arg → widget off in prod.)
- [ ] No unit tests (build config); the real verification is the deploy in Task 4. Confirm `tweaklet` gate still green (these files are outside tweaklet/, no impact).
- [ ] Commit `feat(t8a): embed Tweaklet widget via VITE_TWEAKLET_URL (dev on, prod off); fix loader to /widget.js`.

---

### Task 3: Tweaklet wizard — "panel live in your app" + "agent ready" verification

**Files:** `tweaklet/src/server/server.ts`, `tweaklet/src/server/agent-routes.test.ts`, web `src/api.ts`, `src/SetupWizard.tsx`, `src/*.test.tsx`.

- [ ] Server: `GET /setup/verify-embed` (setup-token-gated) → fetch `${config.server.publicUrl}/` server-side and report `{ embedded: boolean, widgetReachable: boolean }` — `embedded` = the host HTML references `/tweaklet/widget.js` (or `widget.js` under the basePath); `widgetReachable` = a HEAD/GET of `${publicUrl}${basePath}/widget.js` is 200. Inject the fetch impl for tests.
- [ ] Server `GET /setup/verify-agent` (setup-token-gated, requires a signed-in session) → `{ ready: boolean, detail }` = opencode probe ok AND a repo is cloned (`config.repo?.path` is a real `.git`) AND the caller has a token. (Lightweight readiness — NOT a full prompt; the hello-world prompt is P3.)
- [ ] Wizard: add a final **"Verify in your app"** step (after sign-in) showing both checks with Re-check; **Finish is gated** on `embedded && widgetReachable` (per the requirement that setup can't finish until the panel is live). Once `embedded`, surface an **"Open in your app →"** link to `${publicUrl}/`.
- [ ] Tests: `verify-embed` parses host HTML for the snippet (inject fetch returning HTML with/without it); `verify-agent` ready/not-ready; the wizard renders the step + gates Finish; "Open in your app" appears when embedded.
- [ ] Commit `feat(tweaklet): wizard verifies the panel is live + agent ready before Finish`.

---

### Task 4: Deploy to nexus-dev + verify embed live (controller)

- [ ] Wire complete (Tasks 2–3 committed on the branch).
- [ ] Build + push `:dev` from the branch ref with the build-arg: `gh workflow run deploy-dev.yml --ref feat/tweaklet-pluggable-onboarding` (it sets `VITE_TWEAKLET_URL=/tweaklet`). Wait for the run to finish (`gh run watch`).
- [ ] Roll the VM onto the new image: `gcloud compute instances reset t8a-dev-server --zone=us-east1-c` (startup.sh re-pulls `:dev`). Wait for `https://nexus-dev.transcenda.com/` → 200.
- [ ] Verify: `curl https://nexus-dev.transcenda.com/` contains `/tweaklet/widget.js`; load `/` in a browser → the Tweaklet launcher is present over the live app; the wizard's `verify-embed` now reports `embedded:true`.
- [ ] Redeploy the Tweaklet service too (it picked up Task 3) — rebuild on the VM + restart (as in prior redeploys).

---

### Task 5: docs + full gate + push

- [ ] README/INSTALL final pass (snippet + Skill + the verify step).
- [ ] Full gate green (server + web).
- [ ] Push the branch → PR #85; (the t8a frontend/Dockerfile/workflow changes ride along — note in the PR they're additive + prod-off).

## Final verification (controller)
- Review subagent (focus: snippet is relative + idempotent; prod stays widget-off — `VITE_TWEAKLET_URL` only set by deploy-dev; verify-embed/agent checks correct; Finish gating).
- Manual on nexus-dev: open `/` → panel embedded; walk the wizard → Finish only unlocks once the panel is verified live.
