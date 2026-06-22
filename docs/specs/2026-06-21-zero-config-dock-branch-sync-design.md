# Zero-config, docked panel, and branch-sync — design

Design notes for the three features shipped after the initial open-source release
(v0.0.2–v0.0.4). Written after implementation to capture the decisions that only
lived in a GitHub issue and in code comments. See also `CHANGELOG.md`.

## 1. Zero-config defaults (v0.0.2 — issue #1)

**Goal:** `tweaklet serve`, run inside a git repo on a machine that already has
`opencode`, `gcloud` ADC, and `gh`, should work with **no `~/.tweaklet/config.json`**.

**Principle — derive ambient facts, prompt for trust/boundary facts.** A field is
auto-detected if the process can observe it safely; it stays an explicit setup
prompt if it defines a trust boundary with the outside world (guessing it is either
impossible or a security risk).

| Auto-detected | From |
|---|---|
| `repo.path` | current working directory |
| `repo.baseBranch` / `prTarget` | `git symbolic-ref refs/remotes/origin/HEAD` |
| `agent.command` | `which opencode` |
| `agent.cwd` | `= repo.path` |
| `agent.vertexProject` | `gcloud config get-value project` |
| `agent.vertexLocation` / `model` | sensible defaults |
| `server.port` | `4319` |
| `server.sessionSecret` | auto-generated and persisted |
| `access.allowedLogins` | the authenticated `gh api user` (solo/local) |

**Irreducible config (still prompted):**
- **`server.publicUrl`** — the externally-reachable URL behind a reverse proxy. The
  process can see its bind port but not what the internet sees, so it must be
  supplied. It is **never** inferred from inbound `Host` / `X-Forwarded-Host`
  headers — those are attacker-controllable and an OAuth callback derived from them
  is a host-header-injection → token-redirect hijack. Local-only fallback is
  `http://localhost:${port}`.
- **GitHub OAuth client id/secret** — remote multi-user sign-in.
- **`repo.allowlist`** — which repos end-users may touch (multi-user). Solo local
  defaults to the CWD repo.

**Implementation:** `detect.ts` (each helper shells out via `execFileSync` — never a
shell string — and falls back on failure) + `resolveConfig()` in `config.ts`. With
no config file, `resolveConfig` synthesizes one from detection + schema defaults and
persists it. With a file, the file always wins; a file that is operationally
complete but still `setup.completed: false` is **healed** (flipped + persisted) so it
stops printing the setup-token nag (`hasOperationalEssentials`).

**Host-app embed:** the dev loader defaults to `/tweaklet` (same-origin) via
`import.meta.env.DEV` so no `.env` file is needed; `VITE_TWEAKLET_URL` is an override
(non-default basePath, or forcing the widget into a production-mode build). The
reverse proxy / dev-server proxy forwards `/tweaklet/*` to the server.

## 2. Docked side panel (v0.0.3)

**Goal:** the panel should sit *beside* the app, not overlay it, so changes are
visible while iterating.

**Technique.** Opening the panel adds `tweaklet-docked` to the host `<html>`. An
injected stylesheet then:

```css
html.tweaklet-docked body {
  margin-right: 400px;      /* reserve the right column */
  transform: translateZ(0); /* make <body> the containing block for its */
  min-height: 100vh;        /* position:fixed descendants, so the app's   */
}                           /* fixed headers reflow instead of overlapping */
```

The `transform` is load-bearing: a plain `margin-right` reflows normal flow content
but **not** `position: fixed` elements (they stay viewport-relative and slide under
the panel). Giving `<body>` a transform makes it the containing block for its fixed
descendants, so they reflow into the narrower width.

Because `<body>` is transformed, the widget host is mounted on **`<html>`** (a sibling
of `<body>`) so the panel itself stays viewport-fixed in the reserved column rather
than being trapped inside the shrunk app. Below an 880px viewport the shrink is
disabled (media query) and the panel falls back to an overlay; closing restores full
width.

## 3. Branch-sync (v0.0.4)

**Goal:** the working clone must not drift behind `main`. The drift's root cause was
`startBranch` cutting each change branch off the **local** (never-refreshed) base.

- **`syncBase(cwd, base, token)`** — fetch `origin/<base>` authenticated
  (`tokenGitEnv`) and fast-forward the local base. Best-effort: on failure (offline /
  no token / no remote) it logs and returns, so a change can still start from the
  local base. `startBranch` calls it first, so every new change is cut from fresh
  `origin/<base>`. Starting a change therefore does **not** require a token.
- **`syncIntoBranch(cwd, base, token)`** (`POST /agent/sync`) — merge the latest
  `origin/<base>` into the active feature branch for long-lived branches. Returns
  `{status: "dirty" | "up-to-date" | "updated" | "conflict", conflicts?}`. Conflict-
  safe: a dirty tree is skipped; a conflict is aborted (`git merge --abort`) and
  reported. It never auto-resolves and never leaves the tree conflicted.

**Deferred (in-code `TODO(branch-sync)`):**
- A periodic background auto-sync of the active branch (needs an active-holder /
  whose-token model and a dirty-tree policy so it can't disrupt mid-edit).
- Agent-assisted conflict resolution (prompt the agent to resolve a reported
  conflict). For now conflicts are surfaced, not resolved.
