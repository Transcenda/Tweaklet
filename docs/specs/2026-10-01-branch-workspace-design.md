# Branch workspace — every change on a fresh branch, switchable in one click

> **Status:** Current — implemented in v0.0.5 (including the review hardening described below); see docs/ARCHITECTURE.md § Change workspace and § Live preview.

**Date:** 2026-10-01 · **Version:** v0.0.5

## Problem

Found while running Tweaklet on a long-running host that a team used day to day:

1. **Prompts ran on the base branch.** Nothing forced a prompt onto a feature
   branch, so the agent edited `main` in the shared clone directly. Those edits
   were never isolated, never reviewable, and blocked every later sync.
2. **The clone went stale.** `syncBase` only runs from "Start a change", and it
   silently skips the fetch when the in-memory OAuth token is gone (any service
   restart). Over time the clone fell far behind `main`, and a stale
   `vite.config.ts` then broke the live preview outright (Vite's host check,
   `server.allowedHosts`, answered 403 for the public host).
3. **The live preview didn't come back after a reboot.** `ensurePreview` ran only
   on first clone, so a host reboot left Vite down and the reverse proxy quietly
   fell back to the static build. No HMR, and no visible error.
4. **Same-named ideas clobbered each other.** `startBranch` used `checkout -B`.
5. **No overview.** Users couldn't see which changes were in progress, switch
   between them, or clean them up.

## Who it's for

The people using the panel are mostly non-engineers making UI tweaks to a
shared dev deployment. They think in "changes I'm working on", not branches.
They must never lose work, never break the live app for everyone else, and
should be able to leave a change half-done and come back to it later, with the
agent remembering what they were doing.

## Design

### Lifecycle rules (server, `src/git/repo.ts`)

- **`startBranch` = fresh start.** (a) Leave the current tree clean: on a
  feature branch, uncommitted edits are **auto-saved** as a WIP commit, so no
  work is lost. On the base branch (or a detached preview of an earlier save)
  they are **discarded**, because the base must stay pristine. (b) Fetch
  `origin/<base>` (token-authenticated when we have one, otherwise the host's
  own git credentials, never prompting). (c) If the fetch worked, **rescue**
  any commits that exist only on the local base onto a "Recovered work from
  `<base>`" change, then hard-reset the local base to `origin/<base>`. If the
  fetch failed, the change is cut from the last-known local base instead.
  (d) Prune *empty* prefixed branches (0 commits ahead, not current). (e) Cut a
  **uniquely-named** branch (`-2`, `-3`, … on collision), record the human
  title in `branch.<name>.description` and the starter's GitHub login in
  `branch.<name>.tweakletOwner`. Returns `{ branch, title, synced }`.
- **Auto-saves never turn into data loss.** The WIP commit uses `--no-verify`,
  so the host repo's own hooks (husky, commitlint, …) can't reject it. If the
  save still fails, the operation **stops with an error** and nothing is
  discarded.
- **A prompt never runs on the base branch.** `/agent/prompt` auto-starts a fresh
  change (titled from the prompt) when HEAD is the base, and emits a `branch` SSE
  frame so the panel updates. Saves (`/agent/checkpoint`) are refused on the
  base.
- **`listBranches`**: every `refs/heads/<prefix>*` with title, owner, saves
  (commits ahead of base), last-updated, and `current` / `dirty` flags, most
  recently updated first.
- **`switchBranch`**: base or a prefixed branch only. Auto-saves (feature) or
  discards (base) the current tree first, then checks out the target.
- **`deleteBranch`**: prefixed branches only, never the base. When it's the
  current branch, discard it and return to a clean base. The server allows
  deletion **only by the change's owner** (changes from before owners were
  recorded stay deletable by anyone).

### One writer at a time (server, `src/server/server.ts`)

- A **single tree lock** covers every route that moves HEAD or rewrites files
  (start, sync, save, undo, discard, preview/exit/restore, switch, delete). It
  is held for the whole request and refuses (`409`) while an agent turn is
  running or another tree operation is in flight.
- **Prompts are refused** while the lock is held and while the user is
  previewing an earlier save (edits made on a detached preview would be lost).

### Conversation per change

opencode sessions are keyed by `login + branch`, so switching a change restores
its conversation (`/agent/history`), and a new change starts with fresh memory.
`/agent/history` is **time-bounded** (8 s by default), so an unresponsive agent
returns an empty history with an error instead of hanging the panel.

### Live preview self-healing (`src/run/preview.ts`)

`ensurePreview` installs deps when `node_modules` is missing **or the lockfile
hash changed**, records the hash in a stamp file, and (re)starts the unit only
when something changed or the unit isn't active. A running dev server picks up
checked-out files through HMR, so a switch usually costs no restart. Restarts
use `sudo -n systemctl restart <unit>` (a narrow sudoers rule lets the Tweaklet
user restart exactly that unit; `-n` fails fast instead of hanging on a password
prompt). Calls are **serialised**, so overlapping triggers never run two
`npm ci` in the same directory. It runs at `serve` start (fixes the reboot gap),
after clone, and after any start/switch/delete. Failures are logged and
non-fatal. The doctor gains a **live preview** check that reports a stopped
unit.

### Reconnect nudge

`/agent/me` reports `needsReauth` (OAuth configured but no token held, e.g.
after a restart). The panel shows a banner, "GitHub connection expired —
reconnect to start from the latest version and submit", with a **Reconnect**
button. When a start returns `synced: false`, the log explains that the change
starts from the last version Tweaklet saw and suggests reconnecting.

### Panel UX (`web/src/Panel.tsx`)

- **Top bar = change switcher.** It shows the current change's title, or
  "Live app · `<base>`" when no change is checked out, plus a badge with the
  number of changes in progress. Beside it: **New change** (when on the live
  app), or **History** and **Discard** (when on a change).
- **The dropdown** starts with a "Live app" row (go back to the base), then
  "In progress · N" and one row per change: title, saves ("no saves yet",
  "1 save", …), last updated, an **unsaved** tag on the current change when it
  has unsaved edits, and `@owner` when someone else started it. Click a row to
  switch. A ✕ button deletes the change, after a confirm ("Its saved and unsaved
  work is removed for good"); it is shown only on your own changes. "+ New
  change" sits at the bottom. With nothing in progress it says "Describe a change
  below and Tweaklet starts one on a fresh copy of `<base>`."
- **Starting a change** (from New change, or implicitly by sending a prompt
  from the live app) logs "◆ Started “`<title>`” on a fresh copy of `<base>`".
- **Switching** clears the log at once and re-hydrates that change's
  conversation when the agent answers; it never blocks on history.
- **Stage timeline** (Start → Describe → Save → Submit) is derived from server
  state (on a change / has saves), not local flags, so it survives reloads and
  switches.
- **The ↩ recovery button** ("App not responding? Undo the unsaved edits") now
  **undoes unsaved edits** (what "revert the last change" means), keeping saved
  points and the change itself, instead of deleting the whole change. Discarding
  the whole change is the separate **Discard** action.

## Out of scope

- Moving to the v2 opencode permission-reply endpoint (v1 still served by 1.18).
- Persisting OAuth tokens across restarts (deliberately memory-only).
- Multi-user concurrent clones. There is still one shared clone per host. The
  single-holder booking model (`2026-06-19-session-booking-model-design.md`) is
  not built; the tree lock is what keeps concurrent users from clashing.
