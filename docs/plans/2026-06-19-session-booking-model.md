# Tweaklet Session Booking Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **STATUS: not yet started — implement *next* (after the per-user OAuth feature on PR #85 merges).**
> **⚠️ Resolve the 4 Open Questions in the spec first** (`docs/specs/2026-06-19-session-booking-model-design.md` §Open questions). This plan bakes in the proposed defaults: idle 2h, takeover grace 60s, never yank an *active* holder (auto-grant only when idle), auto-checkpoint outgoing work, in-memory booking.

**Goal:** Enforce a single active workspace holder at a time, with takeover requests, idle timeout, and OAuth-token purge on release — closing the concurrency/lifetime gaps from the security review.

**Architecture:** An in-memory `activeSession` record on the server gates all `/agent/*` mutations to the current holder; a takeover handshake + idle timeout release it; releasing purges the holder's token. Plus the setup-flow reframe (sign-in = verify OAuth client; repo health checks move post-clone).

**Tech Stack:** Node/TS ESM server (Express, vitest), Vite/React panel. Builds on the per-user OAuth model (PR #85). Gate (from `tweaklet/`): `npm run build && npm test` + `npm --prefix web run build && npm --prefix web test`. Feature branch + PR.

## DO NOT
No commits to `main`; no `--no-verify`/force-push. Keep the per-user OAuth security properties (token never in cookie/response/log/argv). Never yank an actively-working holder (only idle → auto-grant).

## File Structure
- **Create** `src/server/session.ts` — the booking state machine (pure, testable): `Booking` class/factory with `acquire/release/isHolder/touch/requestTakeover/denyTakeover/status`, holding `{login,name,startedAt,lastActivityAt}` + `pendingRequest` + `idleLimitMs`/`graceMs`. Injectable clock (`now()`).
- **Modify** `src/server/server.ts` — instantiate the booking, gate `/agent/*` mutations, add `/agent/session/*` routes, purge token on release, bump `touch()` on agent activity.
- **Modify** `src/doctor/doctor.ts` — "open allowlist on public URL" warning.
- **Modify** `src/config/config.ts` — `session.idleLimitMinutes` (default 120), `session.takeoverGraceSeconds` (default 60).
- **Modify** web `src/api.ts`, `src/Panel.tsx`, `src/SetupWizard.tsx` — session UI + setup copy/ordering.

---

### Task 1: `session.ts` — booking state machine (pure, clock-injected)

**Files:** Create `src/server/session.ts` + `src/server/session.test.ts`.

- [ ] **Write failing tests** covering: acquire when free; second acquire by another login throws/returns false while held + not idle; `isHolder`; `touch` updates `lastActivityAt`; `status()` reports `idleSeconds`; `requestTakeover` records a pending request; `denyTakeover` clears it; idle past `idleLimitMs` → `status().idle === true` and a new `acquire` by anyone succeeds (auto-release); `release` clears holder + pending. Use an injected `now()` to simulate time.

```ts
// shape
export interface Holder { login: string; name: string; startedAt: number; lastActivityAt: number; }
export interface Pending { byLogin: string; byName: string; at: number; }
export class Booking {
  constructor(opts: { idleLimitMs: number; graceMs: number; now?: () => number });
  status(): { holder: Holder | null; pending: Pending | null; idleMs: number; idle: boolean };
  isHolder(login: string): boolean;
  acquire(login: string, name: string): { ok: true } | { ok: false; holder: Holder; idle: boolean };
  touch(login: string): void;            // bump lastActivityAt if holder
  requestTakeover(byLogin: string, byName: string): "recorded" | "acquired" | "noop";
  denyTakeover(): void;
  release(): Holder | null;              // returns the released holder (for token purge)
}
```
Key logic: `acquire` succeeds if no holder OR holder is idle (`now - lastActivityAt > idleLimitMs`) OR same login; else returns `{ok:false, holder, idle:false}`. `requestTakeover` → if free/idle, `acquire` for the requester and return `"acquired"`; else record pending and return `"recorded"`.

- [ ] Run → fail → implement → pass → commit `feat(tweaklet): booking state machine`.

---

### Task 2: gate `/agent/*` mutations to the holder + `GET /agent/session`

**Files:** `src/server/server.ts`, `src/server/agent-routes.test.ts`.

- [ ] Instantiate `const booking = new Booking({ idleLimitMs: (config.session?.idleLimitMinutes ?? 120)*60000, graceMs: (config.session?.takeoverGraceSeconds ?? 60)*1000 })`.
- [ ] Helper `requireHolder(req,res)`: the signed-in user must be the holder; non-holder → `409 { error:"in use", holder, idleSeconds }`. On a *successful* holder action, call `booking.touch(login)`.
- [ ] Apply to mutation routes: `/agent/prompt`, `/agent/idea`, `/agent/checkpoint`, `/agent/undo`, `/agent/reject`, `/agent/pr` (POST), `/agent/preview*`, `/agent/restore`, `/agent/clone`. Read-only `/agent/me`, `/agent/state`, `/agent/repos`, `/agent/doctor`, `GET /agent/pr` stay open to any signed-in user (so a non-holder can see status).
- [ ] `GET /agent/session` → `{ holder, isMe, idleSeconds, pending }`.
- [ ] Tests: holder can prompt; non-holder gets 409 with holder info; `touch` bumps activity (mock the booking clock); `GET /agent/session` shape.
- [ ] Commit `feat(tweaklet): gate agent mutations to the active session holder`.

---

### Task 3: takeover handshake routes

**Files:** `src/server/server.ts`, `src/server/agent-routes.test.ts`.

- [ ] `POST /agent/session/acquire` → `booking.acquire(login,name)`; 200 `{acquired:true}` or 409 with holder.
- [ ] `POST /agent/session/request` → `booking.requestTakeover(...)`; returns `"acquired"` (200) or `"recorded"` (202 `{pending:true}`).
- [ ] `POST /agent/session/deny` (holder only) → `booking.denyTakeover()`; 204.
- [ ] `POST /agent/session/release` (holder only, also called by `/auth/logout`) → `const released = booking.release()`; purge `released.login` from the token store; 204.
- [ ] Tests: request when free → acquired; request when held → recorded; deny clears pending; release hands over + purges token (assert token-store entry gone).
- [ ] Commit `feat(tweaklet): session takeover request/deny/release routes`.

---

### Task 4: idle auto-release + token purge wiring

**Files:** `src/server/server.ts`, `src/server/agent-routes.test.ts`.

- [ ] On every `GET /agent/session` and every `acquire`/`request`, evaluate idle: if `status().idle`, treat holder as released for acquisition (the `Booking` already encodes this; ensure the token of an idled-out holder is purged — purge lazily when a new holder acquires over an idle one, returning the displaced login from `acquire`).
- [ ] Extend `Booking.acquire` to also return the *displaced* idle holder (if any) so the server purges their token.
- [ ] `/auth/logout` calls `booking.release()` if the logging-out user is the holder + purges (already in Task 3; verify).
- [ ] Tests: simulate idle (advance injected clock) → new acquire succeeds + displaced token purged; non-idle holder not displaced.
- [ ] Commit `feat(tweaklet): idle auto-release + purge displaced holder token`.

---

### Task 5: doctor — warn on open allowlist for a public URL

**Files:** `src/doctor/doctor.ts`, `src/doctor/doctor.test.ts`.

- [ ] Add a `system` check `access allowlist`: if `publicUrl` is non-loopback AND `access.allowedLogins`/`allowedUserIds` are both empty → `warn` "Sign-in is open to any GitHub user — set access.allowedLogins for a shared instance." Else `ok`.
- [ ] Tests: open allowlist + public URL → warn; allowlist set → ok; loopback URL → ok.
- [ ] Commit `feat(tweaklet): doctor warns on open access allowlist for a public URL`.

---

### Task 6: config — session knobs

**Files:** `src/config/config.ts`, `src/config/config.test.ts`.

- [ ] Add optional `session: { idleLimitMinutes?: number (default 120); takeoverGraceSeconds?: number (default 60) }` to `ConfigSchema`.
- [ ] Tests: defaults applied; overrides parsed.
- [ ] Commit `feat(tweaklet): session idle/takeover config knobs`.

---

### Task 7: web — session UI (in-use banner, takeover, idle, holder prompt)

**Files:** web `src/api.ts`, `src/Panel.tsx`, `src/api.test.ts`, `src/Panel.test.tsx`.

- [ ] `api.session()`, `api.acquire()`, `api.requestTakeover()`, `api.denyTakeover()`, `api.releaseSession()`.
- [ ] Panel: on load (signed in) call `api.session()`. If `isMe` → normal UI + on a 409 from any action, switch to the in-use view. If a holder exists and not me → **"In use by `name` (active `N` min ago)"** + **[Request takeover]** (polls `session`); if idle → **[Take the workspace]**. If I'm the holder and `pending` is set → a **"`name` wants the workspace — [Keep working] / [Hand over]"** prompt wired to deny/release.
- [ ] Tests: non-holder session → in-use banner + request calls `api.requestTakeover`; holder + pending → keep/hand-over buttons call deny/release; idle holder → "Take the workspace".
- [ ] Commit `feat(tweaklet): panel session/booking UI`.

---

### Task 8: web — setup-flow reframe (sign-in = verify client; repo step = allowlist; repo health post-clone)

**Files:** web `src/SetupWizard.tsx`, `src/Panel.tsx`, `src/SetupWizard.test.tsx`, `src/Panel.test.tsx`.

- [ ] FinishStep copy: "Sign in with GitHub to **verify your OAuth client**" (+ a one-line note that this session is the first booking, subject to takeover/idle). Remove "activate Tweaklet."
- [ ] Repo setup step: keep the allowlist editor; ensure it does NOT render the repo *health* doctor checks (those move to the panel's post-clone "workspace ready" verification — surface `repo`/`base branch`/`git remote` checks there after `api.clone`).
- [ ] Header/step copy pass for the operator-vs-end-user distinction.
- [ ] Tests: FinishStep shows the new copy; repo step shows only the allowlist editor; post-clone panel shows the repo health verification.
- [ ] Commit `feat(tweaklet): setup-flow reframe — verify-client copy + repo health post-clone`.

---

### Task 9: docs + full gate + PR

- [ ] Update `README.md`/`docs/INSTALL.md`: document the single-active-session model (takeover, idle timeout), the access-allowlist requirement for shared instances, and the verify-client framing.
- [ ] Full gate green (server + web).
- [ ] Commit docs; push branch → PR.

## Final verification (controller)
- Final review subagent (focus: holder-gating on every mutation route; token purged on release/idle/logout; no actively-working holder is ever yanked; allowlist enforced; token never persisted/logged/cookie'd).
- Manual on nexus-dev: two accounts — A holds + tweaks; B sees "in use" + requests; A hands over; B acquires (A's token purged); idle-timeout path; restart releases the booking.
