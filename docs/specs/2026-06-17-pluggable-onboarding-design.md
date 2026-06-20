# Tweaklet — Pluggable URI-Prefix Mount + Onboarding (Phase 1)

**Status:** approved (design) · 2026-06-17
**Goal:** Make Tweaklet a self-contained, host-agnostic product that mounts under a configurable URI prefix on any existing origin (no dedicated domain), installs on a Linux box via one SSH bootstrap, and is configured the rest of the way through a **web Setup Wizard** driven by doctor checks. Remove all t8a coupling.

**Non-goals (Phase 2):** the multi-user booking model — session lock, idle timeout, per-user push attribution, branch registry. Phase 1 is single-developer (you log in and use it).

## Principles
- **One origin, URI prefix.** Default `/tweaklet` (configurable `server.basePath`). The widget is a drop-in `<script src=".../tweaklet/widget.js">` (like GA/Intercom); everything — widget, panel, agent API, OAuth — lives under the prefix with **relative URLs**. No second domain, no Caddy host, no `VITE_*` build-time coupling.
- **Backend serves the frontend.** The panel bundle is packed into the Tweaklet server; `widget.js` is served by it.
- **Self-onboarding.** SSH bootstrap does the irreducible minimum (install deps + start). Everything else (GitHub OAuth client, Vertex, repo selection/clone) is a guided web wizard with green/red doctor checks.
- **Whitelisted repos only.** gh-CLI may clone/operate only on repos in a config allowlist.

## 1. URI-prefix mount + **no-iframe Shadow-DOM embed** (the core decoupling)
> **Revised 2026-06-17:** the embed is **not an iframe**. The widget renders directly into the host page via a Shadow root (Intercom-style). This supersedes the earlier iframe description; the iframe + `__TWEAKLET_BASE__` HTML injection + `postMessage` bridge are removed.

- Add `server.basePath: string` (default `"/tweaklet"`, **charset-validated** to `^/[A-Za-z0-9/_-]*$`). Mount the entire Express app under it (outer `Router`), so routes are `${basePath}/widget.js`, `/agent/*`, `/auth/*`, `/setup/*`. OAuth `redirectUri = ${publicUrl}${basePath}/auth/callback`.
- **`/tweaklet/widget.js` is the whole product, one self-mounting script.** It's the Vite **library** build of the React app (launcher + panel + wizard) with **CSS inlined**. The host adds `<script src="https://host/tweaklet/widget.js">` (like GA/Intercom) and it self-executes:
  1. derive `base` from its own `document.currentScript.src` (strip `/widget.js`) — origin/prefix-agnostic;
  2. create a `<div>` + attach an **open Shadow root** (CSS isolation from the host app, both ways);
  3. inject the bundled CSS into the shadow root;
  4. mount the React UI into the shadow root, passing `base` as a prop/context (so the API client prefixes calls with it — **no `window.__TWEAKLET_BASE__` HTML injection**, which also removes the inline-script XSS surface).
- **Direct host-DOM picker/highlight.** Because the panel runs in the host page's JS context, the element picker queries `document` and highlights host elements directly — **all `postMessage` is removed** (it only existed to cross the iframe boundary).
- **Sign-in via popup.** GitHub's OAuth page can't be embedded (X-Frame-Options) regardless of embed style, so the panel opens `<base>/auth/login` in a popup/tab; the callback closes it and the panel polls `<base>/agent/me`. Same-origin (the host proxies `<base>/*`), so the session cookie is the host-origin cookie.
- **Bare `/tweaklet/`** serves a tiny bootstrap HTML page that just loads `widget.js` — lets a developer open `https://host/tweaklet/` to run first-time setup *before* the snippet is embedded in their app. (No more redirect-to-login; the `/panel/` HTML route is removed.)
- Host wiring (documented): the host reverse-proxies `${basePath}/*` → the Tweaklet port. For nexus-dev that's a Caddy path-route to `:4319` — no new domain.

## 2. Repo allowlist + gh clone
- Config `repo.allowlist: string[]` — git URLs (or `owner/name`) the server may clone. `repo.path` (the working checkout) and `repo.sourceDir` (where clones live).
- A setup endpoint clones a chosen allowlisted repo via `gh repo clone` into `sourceDir`, sets `repo.path`, checks out `baseBranch`. Refuses any repo not in the allowlist (validated server-side, not just UI).
- The agent's `cwd` and Vite's working dir both point at `repo.path`; `run.liveUpdate=hot-reload` (already in config) means the agent's edits land in the checkout Vite serves with HMR → live preview.

## 3. Dependency install — GUIDED, not scripted
No auto-install script. Two layers:
- **Irreducible bootstrap (docs only).** To even *see* the wizard, the host needs Node + the Tweaklet process running. `docs/INSTALL.md` covers just that: install Node LTS, `git clone` Tweaklet, `npm i && npm run build`, `node dist/index.js serve`, and expose `<basePath>/*` (reverse-proxy snippets: Caddy path handle, nginx location). Nothing else.
- **Everything else is a wizard step the engineer performs over SSH, then verifies in the UI.** The wizard's **Dependencies** step lists each required tool (`git`, `gh`, `opencode`, and the min Node version) with its current doctor status, and for any missing/outdated one shows the **exact install command + package name for the detected distro** (read `/etc/os-release` → `apt install …` / `dnf install …` / the `gh`/`opencode` vendor one-liner). The engineer runs it via SSH, clicks **Re-check**, and doctor re-validates presence + version. We guide, the engineer installs, doctor confirms — never auto-install.

## 4. Web Setup Wizard (the UX focus)
When the server is **not fully configured**, the panel renders the **Setup Wizard** instead of the agent UI. The wizard is **resumable, not strictly linear**: on open it runs **ALL doctor checks at once** to compute current state, renders the full step list with per-step green/red status, and drops the engineer at the first unmet step — so re-opening always picks up exactly where they left off (idempotent). Steps:
1. **Dependencies** — `git` / `gh` / `opencode` / Node-version checks, each with the distro-specific install command for any gap (see §3) + a **Re-check** button.
2. **GitHub OAuth** — guided: explains creating a GitHub OAuth App, shows the exact **Authorization callback URL** (`<publicUrl><basePath>/auth/callback`) to paste, captures client id + secret → saved to config; doctor verifies the OAuth config loads.
3. **Vertex / agent** — capture `vertexProject`/`vertexLocation`/`model`; doctor "vertex credentials" (ambient ADC found, or guide `gcloud auth application-default login` / a key) + an opencode smoke check.
4. **Repository** — pick from `repo.allowlist`, clone via gh, verify checkout + `gh auth status` (push capability) + set `guardrails.allow` for this repo.
5. **All green → Sign in with GitHub** → the normal agent panel.
- Backend: setup endpoints (`GET <base>/setup/state` returns the full doctor result + per-step status + `completed`, `POST <base>/setup/github`, `/setup/agent`, `/setup/repo`, re-run `<base>/setup/doctor`) — **unauthenticated only while unconfigured**, then locked once setup completes (so it can't be re-run by anyone). Reuse `doctor.ts`; extend with node-version + distro detection + publicUrl-reachable.
- Frontend: a `SetupWizard` component (sibling of `Panel`) shown by the widget when `setup/state.completed === false`; it renders all steps with live status and lets you act on any incomplete one in any order.

## 5. Decouple from t8a
- Remove the t8a-specific bits: the `frontend/index.html` `VITE_TWEAKLET_URL` loader is no longer how it embeds (drop-in `<script>` now); guardrails default `["frontend/src/**"]` becomes a config value the wizard sets per-repo (no hard t8a path baked in); any t8a naming in prompts/docs already removed — verify none remains.

## Config additions (summary)
`server.basePath` (default `/tweaklet`); `repo.allowlist: string[]`, `repo.sourceDir`; a `setup.completed: boolean` marker. Everything else (github/agent.vertex*/run.liveUpdate/guardrails/access) already exists.

## Testing
- Web (vitest/jsdom): `widget.js` base-from-script-src derivation; api client prefixes `__TWEAKLET_BASE__`; SetupWizard renders per `setup/state` + advances as checks go green; wizard hidden once configured.
- Server (vitest): all routes mount under a non-default basePath; OAuth redirect uses `publicUrl+basePath`; repo-allowlist rejects a non-listed repo; setup endpoints lock after completion.
- Doctor: the extended checks return the right status/fix.
- Manual: install.sh on a clean Debian box (or the nexus-dev VM) → wizard → green → login → a prompt edits the checkout live.

## Rollout
Build on a **feature branch → PR** (Tweaklet now uses PRs, not trunk-based, as of 2026-06-17). Run the Tweaklet gate (backend `npm run build && npm test` + web `npm run build && npm test`) before pushing. Then a follow-up turns nexus-dev into the first host (Caddy `/tweaklet/*` path-route + the bootstrap + the wizard) — tracked separately.
