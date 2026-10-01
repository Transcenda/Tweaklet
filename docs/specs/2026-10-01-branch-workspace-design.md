# Branch workspace — every change on a fresh branch, switchable in one click

**Date:** 2026-10-01 · **Status:** approved (owner request) · **Ships in:** v0.0.5

## Problem

Found on the dogfood Dev Server (nexus-dev):

1. **Prompts ran on the base branch.** Nothing forced a prompt onto a feature
   branch, so the agent edited `main` in the shared clone directly. Those edits
   were never isolated, never reviewable, and blocked every later sync.
2. **The clone went stale (355 commits behind).** `syncBase` only runs from
   "Start a change", and it silently skips the fetch when the in-memory OAuth
   token is gone (any service restart). Stale `vite.config.ts` then broke the
   live preview outright (Vite host-check 403).
3. **The live preview didn't come back after a reboot.** `ensurePreview` ran only
   on first clone, so a VM reboot left Vite down and Caddy quietly served the
   static build. No HMR, and no visible error.
4. **Same-named ideas clobbered each other.** `startBranch` used `checkout -B`.
5. **No overview.** Users couldn't see which changes were in progress, switch
   between them, or clean them up.

## Design

### Lifecycle rules (server, `src/git/repo.ts`)

- **`startBranch` = fresh start.** (a) Leave the current tree clean: on a
  feature branch, uncommitted edits are **auto-saved** as a WIP commit, so no
  work is lost. On the base branch they are **discarded**, because the base must
  stay pristine. (b) Fetch `origin/<base>` (token-authenticated when we have one,
  otherwise plain git creds, never prompting). (c) Hard-reset the local base to
  `origin/<base>`. (d) Prune *empty* prefixed branches (0 commits ahead, not
  current). (e) Cut a **uniquely-named** branch (`-2`, `-3`, … on collision) and
  record the human title in `branch.<name>.description`. Returns
  `{ branch, title, synced }`.
- **A prompt never runs on the base branch.** `/agent/prompt` auto-starts a fresh
  change (titled from the prompt) when HEAD is the base, and emits a `branch` SSE
  frame so the panel updates.
- **`listBranches`**: every `refs/heads/<prefix>*` with title, saves (commits
  ahead of base), last-updated, and `current` / `dirty` flags, newest first.
- **`switchBranch`**: base or a prefixed branch only. Auto-saves (feature) or
  discards (base) the current tree first, then checks out the target.
- **`deleteBranch`**: prefixed branches only, never the base. When it's the
  current branch, discard it and return to a clean base.

### Conversation per change

opencode sessions are keyed by `login + branch`, so switching a change restores
its conversation (`/agent/history`), and a new change starts with fresh memory.

### Live preview self-healing (`src/run/preview.ts`)

`ensurePreview` installs deps when `node_modules` is missing **or the lockfile
hash changed**, records the hash in a stamp file, and (re)starts the unit only
when something changed or the unit isn't active. It runs at `serve` start (fixes
the reboot gap), after clone, and after any start/switch/delete. The doctor gains
a **live preview** check.

### Reconnect nudge

`/agent/me` reports `needsReauth` (OAuth configured but no token held). The panel
shows a "Reconnect GitHub" banner, and `synced: false` from a start explains that
the change was cut from the last-known base.

### Panel UX (`web/src/Panel.tsx`)

- Top bar = **change switcher**: the current change's title (or "main · live
  app"), plus a count of changes in progress. The dropdown lists each change
  (title, saves, updated, unsaved dot): click to switch, 🗑 to delete (with
  confirm), and "+ New change".
- Switching clears the log and re-hydrates that change's conversation.
- Stage timeline is derived from server state (on a change / has saves), not
  local flags, so it survives reloads and switches.
- The ↩ recovery button now **undoes unsaved edits** (what "revert the last
  change" means), instead of deleting the whole change.

## Out of scope

- Moving to the v2 opencode permission-reply endpoint (v1 still served by 1.18).
- Persisting OAuth tokens across restarts (deliberately memory-only).
- Multi-user concurrent clones (the booking model stays one holder per host).
