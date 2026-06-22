# Changelog

Notable changes to Tweaklet. Each version ships as a prebuilt GitHub Release
tarball (`tweaklet-server.tgz`); install/upgrade with
`npm i -g https://github.com/Transcenda/Tweaklet/releases/latest/download/tweaklet-server.tgz`.

## v0.0.4 — Branch-sync (2026-06-21)

- **The working tree stays current with `main`.** Each change now branches off a
  freshly-fetched `origin/<base>` instead of the local (possibly stale) base, so a
  long-lived clone can no longer drift behind `main` (`syncBase`). Starting a change
  does **not** require a token — `syncBase` is best-effort, so local / CLI-auth
  setups (no stored OAuth token) still work; the fetch is just skipped.
- **On-demand `POST /agent/sync`** — merges the latest `origin/<base>` into the
  active feature branch. Conflict-safe: a dirty tree is skipped, a conflict is
  aborted and reported (`{status: "conflict", conflicts: […]}`), never auto-resolved
  and never left in a conflicted state.
- Deferred (tracked in code as `TODO(branch-sync)`): a periodic background
  auto-sync, and agent-assisted conflict resolution.

## v0.0.3 — Docked side panel (2026-06-21)

- The panel **docks beside the app** instead of overlaying it. Opening it marks the
  host `<html>` (`tweaklet-docked`); an injected stylesheet shrinks `<body>`
  (`margin-right` + a `transform` so the app's `position: fixed` headers reflow too,
  not just flow content) and reserves the right column. The widget host moved to
  `<html>` so it stays viewport-fixed in that column. Below 880px it falls back to an
  overlay. Closing restores full width. Lets you iterate and watch changes land
  without closing the panel.

## v0.0.2 — Zero-config defaults (2026-06-20)

- `tweaklet serve` in a git repo now starts with **no `~/.tweaklet/config.json`**.
  It auto-detects the repo (CWD), the default branch (`origin/HEAD`), the `opencode`
  binary (PATH), the GCP project (gcloud), and the gh identity; auto-generates and
  persists the session secret; and writes a config you can inspect and edit.
- A functionally-complete config is **healed** (its `setup.completed` flag is flipped)
  so it stops printing the one-time setup-token nag.
- Host-app embed: the dev loader defaults to `/tweaklet` (same-origin) via
  `import.meta.env.DEV` — **no `.env` file needed**; `VITE_TWEAKLET_URL` is only an
  override.
- Design: [#1](https://github.com/Transcenda/Tweaklet/issues/1) and
  [`docs/specs/2026-06-21-zero-config-dock-branch-sync-design.md`](docs/specs/2026-06-21-zero-config-dock-branch-sync-design.md).

## v0.0.1 — Initial open-source release (2026-06-20)

- First public release as a standalone repo (previously developed inside the t8a
  monorepo). Includes the self-mounting Shadow-DOM widget, the opencode-on-Vertex
  agent, per-user GitHub OAuth, the change lifecycle (start → save points → submit
  PR), the in-app live preview + DOM-inspect MCP + crash-safe recovery (the "closed
  loop"), and the in-browser setup wizard. Distributed as a prebuilt GitHub Release
  tarball — no npm registry account required.
