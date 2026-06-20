# Tweaklet VCS Surface — Design

**Date:** 2026-06-15
**Status:** Approved (design) — pending spec review before implementation
**Goal:** Give non-technical Tweaklet users a safe, legible version-control surface inside the panel: see where they are, start/discard a feature branch, save and move through a history of saved points, and submit a Pull Request to hand off to developers.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Commit navigation | A **clickable timeline** of saved points (commits), newest first |
| Restore model | **Preview (read-only) → confirm**; restoring is **non-destructive** (a new save on top — nothing is ever lost) |
| Branch model | **One feature branch at a time** (you're on `main` or your single working branch) |
| Saves | **Manual** ("Save" = an intentional point), not auto-commit on every agent edit |
| Branch naming | **Auto-generated from a developer-configured convention** (`repo.branchPrefix`); users never name branches |

## What the user sees

A **"where you are" bar** at the top of the panel, in one of two states:

```
On main:      main · you're viewing the live app          [ Start a change ]   ↻  Ⓦ
On a branch:  ● Working: "make-header-bigger"   [History] [Discard]            ↻  Ⓦ
                Describe ──○── Save ──○── Submit        (the existing lifecycle)
```

- **On `main`** the panel is read-only; the only action is **Start a change**, which creates the feature branch. This is the literal "see where they are."
- **On a feature branch** the branch name shows, with **Discard** (→ back to `main`, drops the branch) and **History**.

**History — the saved-points timeline** (opens from `[History]`), newest first; each entry is a commit on this branch:

```
  ● "bigger CTA + spacing"        just now       ← current
  ○ "moved filter above table"    5 min ago      [Preview]
  ○ "first draft"                 12 min ago      [Preview]
```

**Preview → confirm flow:** clicking **Preview** puts that older point's state into the live app (read-only) and shows a banner:

```
  👁 Previewing "moved filter above table"      [ Restore here ]   [ Back to latest ]
```

- **Restore here** snapshots that state as a *new* point at the top of the timeline (non-destructive), then returns to live editing.
- **Back to latest** exits preview to the newest point.

## Backend (`tweaklet/src/git/repo.ts` + `server.ts` + `web/src/api.ts`)

New git operations (real `git`, dependency-injected like the rest):

- `branchState(cwd, base)` → `{ branch, base, onFeature, commits }`, where `commits` is `git log base..HEAD` parsed to `[{ sha, message, relativeTime }]` — only this branch's saved points, not `main`'s history.
- `previewCommit(cwd, sha)` → set the working tree to that commit so the running app reflects it, **without moving HEAD** (`git checkout <sha> -- .`). Read-only preview.
- `exitPreview(cwd, branch)` → restore the working tree to the branch tip (`git checkout <branch> -- .`).
- `restoreCommit(cwd, branch, sha)` → create a **new** commit on the branch whose tree equals `sha` (`git checkout <sha> -- .` then `checkpoint`). Non-destructive; the timeline only grows.

New routes (all behind `authGate`):
- `GET /api/state` → `branchState` + a `previewing: sha | null` flag. Drives the bar + History.
- `POST /api/preview { sha }`, `POST /api/preview/exit`, `POST /api/restore { sha }`.

Reused as-is: `POST /api/idea` = **Start**, `POST /api/checkpoint` = **Save**, `POST /api/reject` = **Discard**, `POST /api/pr` = **Submit** (draft PR handoff).

`api.ts` additions: `state()`, `preview(sha)`, `exitPreview()`, `restore(sha)`.

## Branch naming (developer setup)

The branch convention is **configured by the developer** when they set up the Tweaklet server, via `repo.branchPrefix` in `~/.tweaklet/config.json` (default **`tweaklet/`**). Branches are auto-generated as:

```
<branchPrefix><slug-of-request>          e.g.  tweaklet/make-header-bigger
```

`slug` is the slugified first request (existing `slugify`). A collision appends a short numeric suffix. The developer picks `branchPrefix` to match their team's convention (`tweaklet/`, `feature/`, `proposals/`, …). This is documented in the README setup section. Non-technical users never see or choose branch names.

## Safety / error handling
- **Preview is read-only:** the composer + agent are disabled while previewing; the user must **Restore here** or **Back to latest** before editing again. Prevents committing onto a detached state.
- **Restore is non-destructive** — always a new commit; nothing is ever discarded by moving through history.
- **Unsaved changes + Preview:** if the working tree is dirty, Preview is blocked with a gentle "Save your current changes first" (no silent loss).
- Guards: Save/Submit/History require a feature branch; operations never touch `main`; `assertSafeRef` on branch/base; no force-push; `/api/reject` (Discard) remains the only path that drops a branch, and only a prefixed non-base branch.

## Testing
- `repo.test.ts` (real temp-git): `branchState` lists only `base..HEAD` saves; `previewCommit`/`exitPreview` swap and restore the working tree; `restoreCommit` adds a new commit, tree matches the target, and earlier/later commits all survive.
- Route tests for `/api/state`, `/api/preview`, `/api/preview/exit`, `/api/restore` (dependency-injected git stub).
- `Panel.test.tsx`: branch bar reflects `state()`; on `main` shows "Start a change"; History lists saved points; Preview shows the banner + disables the composer; "Restore here" calls `api.restore`.

## Out of scope (YAGNI)
- Multiple concurrent branches / a branch switcher.
- Editing or reordering history; squashing; per-commit diffs in the timeline (the agent stream already shows diffs).
- Conflict resolution UI (single-user, single-branch model avoids it).
- Auto-commit on every agent edit.
