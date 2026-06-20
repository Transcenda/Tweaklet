# Tweaklet — No-iframe Shadow-DOM Re-architecture + Pre-merge — Plan

> REQUIRED SUB-SKILL: subagent-driven-development. Spec §1 (revised). Branch `feat/tweaklet-pluggable-onboarding` (PR #85). Tweaklet uses feature-branch + PR; gate = `cd tweaklet && npm run build && npm test` + `npm --prefix web run build && npm --prefix web test`.

**Goal:** Replace the iframe embed with a self-mounting Shadow-DOM `widget.js`; remove `postMessage` (direct host-DOM picker); popup sign-in; bare-route bootstrap page; + the remaining hardening (gh access check, basePath validation, route tidy). This makes PR #85 mergeable.

## DO NOT
- No commits to `main`. No `--no-verify`/force-push. Keep the backend `/agent`/`/auth`/`/setup` routing, config, allowlist, doctor, and the SetupWizard/Panel React logic working — only the EMBED mechanics change.

---

### Task 1: `widget.js` = self-mounting Shadow-DOM library bundle
**Files:** `tweaklet/web/*` (vite config, a new `web/src/embed.ts` entry, `App.tsx`, `api.ts`), `tweaklet/src/server/server.ts`, `tweaklet/src/index.ts`.
- [ ] Add a Vite **library build** that produces a single self-contained IIFE `widget.js` (React + the app + CSS inlined). New entry `web/src/embed.ts`: on load, derive `base` from `document.currentScript.src` (strip `/widget.js`); create `<div id="tweaklet-root">`, attach an **open Shadow root**; inject the bundled CSS string into the shadow root (`<style>`); render the React app (launcher + `App`) into the shadow root, providing `base` via a React context or a module-level setter consumed by `api.ts`.
- [ ] `api.ts`: replace `window.__TWEAKLET_BASE__` with the `base` provided at mount (a `setBase(base)` called by `embed.ts`, or a context). Every fetch prefixes it.
- [ ] Server: serve the built bundle at `${basePath}/widget.js` (read the library output file). **Remove** the old snippet IIFE string, the `/panel` + `/panel/*` HTML routes, and the `__TWEAKLET_BASE__` injection.
- [ ] Bare `${basePath}/` → serve a tiny bootstrap HTML page: `<!doctype html><script src="<base>/widget.js"></script>` (so first-run setup works before the host embeds the snippet). Remove the old login-redirect.
- [ ] Tests: web — `embed.ts` derives base from a mocked `currentScript.src`; mounts into a shadow root; `api.ts` uses the set base. Server — `widget.js` route serves JS (content-type), bare route serves the bootstrap HTML, `/panel` is gone.
- [ ] Commit: `feat(tweaklet): self-mounting Shadow-DOM widget.js (drop iframe + __TWEAKLET_BASE__)`.

---

### Task 2: Direct host-DOM picker/highlight (remove postMessage)
**Files:** `tweaklet/web/src/Panel.tsx` (+ wherever the picker/highlight + the old snippet message handlers live).
- [ ] Rewrite the element picker to operate on the host `document` directly (the panel is now in the host context): click-to-pick with a hover outline, Esc to cancel, capture the element's tag/id/classes/selector — reuse the existing `contextCapture.ts` serialization.
- [ ] Highlight-on-hover: when hovering a picked chip, outline the actual host element directly (no message round-trip).
- [ ] **Remove all `postMessage`** (panel side and the former snippet handlers) and the related origin-gating.
- [ ] Tests: picking a host element (jsdom) populates the context chip; clearing removes it; no postMessage is used.
- [ ] Commit: `feat(tweaklet): direct host-DOM element picker (remove postMessage bridge)`.

---

### Task 3: Popup GitHub sign-in
**Files:** `tweaklet/web/src/{App.tsx,Panel.tsx,SetupWizard.tsx}`, `tweaklet/src/server/server.ts` (callback page).
- [ ] Sign-in opens `<base>/auth/login` via `window.open(...)` (popup); after it completes, the panel detects sign-in by polling `<base>/agent/me` (or the callback page `postMessage`s its same-origin opener then `window.close()`s).
- [ ] The `/auth/callback` success response: a tiny HTML page that notifies the opener and closes itself.
- [ ] Tests: clicking sign-in calls `window.open` with the `<base>/auth/login` URL; on `me` returning a user the UI advances.
- [ ] Commit: `feat(tweaklet): popup-based GitHub sign-in (works without an iframe)`.

---

### Task 4: Hardening — gh access check + basePath validation + route tidy
**Files:** `tweaklet/src/repo/clone.ts`, `tweaklet/src/config/config.ts`, `tweaklet/src/server/server.ts`.
- [ ] `cloneAllowedRepo`: after the allowlist check + before clone, run `gh repo view -- <owner>/<name>` (or `gh api repos/<owner>/<name>`); non-zero → throw "repo not found or not accessible with the current GitHub auth". (Optional: a `repoAccessible(ref)` helper the wizard can use to filter the dropdown.)
- [ ] `config.ts`: `server.basePath` — refine to `^/[A-Za-z0-9/_-]*$` (reject `<>"'`, etc.) so routing + the bootstrap page are safe.
- [ ] Tidy the `/agent/agent/prompt` double segment → `/agent/prompt` (and the client call), so the prompt route reads cleanly.
- [ ] Tests: clone throws when `gh repo view` fails (inject exec); basePath with `<` rejected; the prompt route resolves at `/agent/prompt`.
- [ ] Commit: `feat(tweaklet): gh access check + basePath validation + tidy prompt route`.

---

### Task 5: Docs + final gate + PR
- [ ] Update `INSTALL.md` + `README.md`: the `<script src=".../tweaklet/widget.js">` drop-in (note SRI is optional since it's self-hosted same-origin), the bootstrap URL for first setup, no iframe/domain. Remove stale iframe/panel mentions.
- [ ] Full gate green (server + web build+test).
- [ ] Commit docs; push the branch (one gate run) updating PR #85.

## Final verification (controller)
- Final review subagent (focus: shadow-mount correctness, no leftover postMessage/iframe, popup-auth flow, gh-access enforcement).
- Manual: build `widget.js`, drop it into a throwaway HTML page, confirm the launcher + wizard render in a shadow root and the picker highlights host elements.
