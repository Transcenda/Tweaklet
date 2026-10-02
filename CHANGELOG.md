# Changelog

Notable changes to Tweaklet. Each version ships as a prebuilt GitHub Release
tarball (`tweaklet-server.tgz`); install/upgrade with
`npm i -g https://github.com/Transcenda/Tweaklet/releases/latest/download/tweaklet-server.tgz`.

## v0.0.5 — Change workspace (2026-10-01)

- **Every change runs on a fresh branch.** A prompt sent from the live app now
  starts a new change automatically: Tweaklet fetches `origin/<base>`,
  hard-resets the local base to it, discards stray edits there, and cuts a
  uniquely named branch. Same-named ideas no longer overwrite each other. Any
  commits that exist only on the local base are first moved to a "Recovered
  work" change, so the reset can't destroy committed work.
- **Change switcher.** The panel's top bar lists every change in progress, with
  its saves, last update, an unsaved marker, and who started it. You can switch
  in one click; each change keeps its own agent conversation. You can delete
  your own changes and go back to the live app. Switching auto-saves unsaved
  edits, bypassing repo hooks, and refuses rather than ever discarding work.
- **Live preview self-heals.** It reinstalls deps when the lockfile changes,
  restarts the dev server only when it's stopped, runs at `serve` start (so it
  recovers after a reboot), and gets a doctor check of its own.
- **Safety.** A single lock covers every working-tree operation. Prompts are
  refused while previewing an earlier save. Saves never land on the base. Only
  the owner can delete a change. `/agent/history` is bounded, so a stuck agent
  can't hang the panel.
- **Reconnect nudge** when the server has lost the GitHub token (e.g. after a
  restart). Without the token it can't fetch the latest base or submit.
- The ↩ recovery button now undoes unsaved edits instead of deleting the change.
- **One active user at a time.** Signing in holds the server under that
  person's GitHub identity. Others are told it's in use, and when it frees up,
  until the holder signs out or is idle for `session.idleMinutes` (default 30).
  On release the holder's token is erased.
- **Security hardening.**
  - Local-only routes stay local behind a reverse proxy: the DOM-inspect MCP
    endpoint needs a per-process token, and `gh` CLI sign-in needs a direct
    local request and is off when OAuth is configured.
  - The server binds to `127.0.0.1` by default (`server.host` overrides it).
  - Sessions expire, are revocable and purpose-tagged, and the cookie is
    `Secure` and scoped to the base path.
  - API and sign-in routes are rate-limited.
  - Dependencies audit clean.
- **Auto approvals on shared servers.**
  - Tweaklet now launches opencode so it asks before every tool use. A host
    repo's own opencode config can't loosen this.
  - On servers with GitHub sign-in, Tweaklet decides everything itself:
    reads, edits inside the guardrails, and an exact-match safe-command list
    (read-only git, typecheck, lint) are allowed; other commands and web
    access are denied and explained in the panel.
  - Ask mode (an Allow/Deny prompt for risky actions) remains the default for
    a developer's own machine. Configure with `agent.approvals` and
    `agent.safeCommands`.
  - Sub-agents and access outside the repo are always denied.
  - The panel mounts in a closed shadow root and keeps its own `fetch`.
- **Requires the current Node LTS (24+).** Only the current LTS line is supported now (`engines: >=24`). Node 20 reached end-of-life in April 2026. The doctor reports older Node as a failure with an upgrade hint, so upgrade the host's Node before installing this release.
- `@opencode-ai/sdk` 1.18.34. Install `opencode-ai@1.18.34` on the host to match.
- Design: [`docs/specs/2026-10-01-branch-workspace-design.md`](docs/specs/2026-10-01-branch-workspace-design.md).

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

- First public release as a standalone repo (previously developed privately).
  Includes the self-mounting Shadow-DOM widget, the opencode-on-Vertex agent,
  per-user GitHub OAuth, the change lifecycle (start → save points → submit PR),
  the in-app live preview + DOM-inspect MCP + crash-safe recovery (the "closed
  loop"), and the in-browser setup wizard. Distributed as a prebuilt GitHub Release
  tarball — no npm registry account required.
