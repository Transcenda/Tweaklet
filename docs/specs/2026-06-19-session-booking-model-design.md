# Tweaklet — Single-Active-Session "Booking" Model + Session Hardening (design)

**Status:** approved direction (2026-06-19) · **implementation deferred** (this is the planned "Phase 2" session work; see the companion plan in `docs/plans/`).
**Builds on:** the per-user OAuth model (`2026-06-18-per-user-github-oauth-design.md`, shipped on PR #85). That made git run under each user's OAuth token; this bounds the *session lifecycle* and enforces *one active user at a time*.

## Why

A security review of the per-user OAuth handling found:

- **Safe already:** session impersonation is impossible — the browser holds only an HMAC-signed httpOnly `{login,id}` cookie; the OAuth token lives only in server memory (never in a cookie/response/log/argv). User B cannot operate under User A's GitHub session or token.
- **Gaps this spec closes:**
  1. **No single-active-session enforcement** — multiple authorized users can hold valid sessions at once and clobber each other on the one shared working tree.
  2. **No idle timeout** — a token lives in memory until logout/restart.
  3. **Token lifetime unbounded** — not purged on idle or handover.
  4. **Access allowlist often unenforced** — if `access.allowedLogins` is empty, any GitHub user who completes OAuth gets in.

**Rejected alternatives (and why):** *Browser-held token* — the agent/git run server-side, so a browser-only token must be re-sent per request (more exposure, less secure); the opaque-cookie + server-token pattern is correct. *Reuse the host app's login* — Tweaklet is host-agnostic, and a host session isn't a GitHub credential anyway (you still need a token to clone/commit/PR). **Decision: keep GitHub OAuth + server-side token; bound its lifetime and enforce one holder.**

## The model

### Active-session ("booking") state
A single in-memory record (one per server — Tweaklet is one instance):
```
activeSession: { login, name, startedAt, lastActivityAt } | null
```
- **In-memory, not persisted** — a server restart releases the booking (acceptable for a single dev instance; documented).
- `lastActivityAt` is bumped on every agent interaction (`/agent/prompt`, `/agent/checkpoint`, `/agent/idea`, `/agent/pr`, etc.).

### Acquiring the session
- A signed-in, allowlisted user with `activeSession == null` (or expired — see idle) **becomes the holder** on their first agent action (or explicitly via a "Take the workspace" action). `activeSession` is set.
- All `/agent/*` mutation routes require the caller to be the current holder; a non-holder gets `409 { error: "in use", holder: { login, name, lastActivityAt }, idleSeconds }`.

### A second user arrives
The panel, for a non-holder, shows: **"In use by `name` (active `N` min ago)."** with two choices:
- **Wait** (poll `GET /agent/session` for status).
- **Request takeover** → `POST /agent/session/request` records a pending takeover request `{ byLogin, byName, at }`.

### Takeover handshake
- The **holder** is notified (SSE event on their open stream, or surfaced on their next poll): **"`name` is requesting the workspace."** with **[Keep working]** / **[Hand over]**.
  - **Keep working** → `POST /agent/session/deny` clears the request; requester is told "denied, still in use."
  - **Hand over** → `POST /agent/session/release` releases (see Release).
- **Grace window:** if the holder doesn't respond within `TAKEOVER_GRACE` (default **60s**) AND is past a short inactivity threshold, the request escalates to an idle/forced release (configurable; default: a takeover request only auto-grants once the holder is **idle**, never yanks an actively-working holder).

### Idle timeout
- If `now − lastActivityAt > IDLE_LIMIT` (default **2h**, configurable `session.idleLimitMinutes`), the session is **auto-released** — the next requester (or any allowlisted user) can acquire without a handshake.
- Surfaced in the panel as "paused (idle)".

### Release (handover / timeout / logout)
On release for any reason:
1. Clear `activeSession`.
2. **Purge the released holder's OAuth token** from the token store (bounds token lifetime; they re-auth to return).
3. Optionally **checkpoint** the outgoing holder's uncommitted work to their branch so nothing is lost (see Open question 3).
4. The new holder, on acquire, starts a **fresh idea/branch** (their own `branchPrefix` + idea); the working tree is reset to `baseBranch` for them.

### Access allowlist
- **Enforced** (already supported via `access.allowedLogins`/`allowedUserIds`). This spec adds a **loud setup-wizard warning + a doctor check** when a non-loopback `publicUrl` has an empty allowlist (a shared instance with open sign-in is a misconfiguration).

## Setup-flow reframe (companion fixes)

These ride along because they're part of the same session story:
1. **Sign-in is "verify your OAuth client," not "activate Tweaklet."** Setup copy + the FinishStep button change to make clear the developer is *testing the GitHub client*, and that their session is just the first booking (subject to takeover/idle), not privileged.
2. **Repo setup step = allowlist editor only.** The repo *health* checks (`.git` present, base branch exists, origin remote) can't pass until a repo is **cloned**, which is **post-sign-in** — so they move out of operator-setup and into a **post-clone "workspace ready" verification** in the panel.
3. **Wizard copy pass** — the header and step language reviewed for the operator-vs-end-user distinction.

## API surface (additions)

| Route | Purpose |
|---|---|
| `GET /agent/session` | current booking: `{ holder?, isMe, idleSeconds, pendingRequest? }` |
| `POST /agent/session/acquire` | become holder if free/idle |
| `POST /agent/session/request` | request takeover (records pending) |
| `POST /agent/session/deny` | holder denies a pending request |
| `POST /agent/session/release` | holder hands over (or logout calls it) |
| (all `/agent/*` mutations) | gated: must be the holder, else 409 with holder info |

Holder-notification: reuse the existing SSE stream (`/agent/prompt` events) + a lightweight `GET /agent/session` poll for the idle panel.

## Components touched

- `src/server/server.ts` — `activeSession` state + helpers (`acquire`/`release`/`isHolder`/`touch`), the `/agent/session/*` routes, holder-gating on `/agent/*` mutations, token purge on release, `lastActivityAt` bumps.
- `src/auth/...` / token store — purge on release/logout/idle.
- `src/doctor/doctor.ts` — "open access allowlist on a public URL" warning.
- web `Panel.tsx` — in-use banner, request-takeover button, holder's keep/hand-over prompt, idle state; `api.ts` session methods.
- web `SetupWizard.tsx` — sign-in-as-verification copy; repo step = allowlist; repo health → post-clone panel check.
- `config.ts` — `session.idleLimitMinutes`, `session.takeoverGraceSeconds`.

## Security properties (target)

- One OAuth token in memory at a time (the active holder's); purged on release/idle/restart.
- Non-holders cannot run any agent/git action (409).
- Sign-in restricted to the access allowlist (enforced; loud warning if open on a public URL).
- Token still never in a cookie/response/log/argv (unchanged from the per-user model).

## Error handling

- Non-holder mutation → `409 { error:"in use", holder, idleSeconds }` (panel renders the in-use UI).
- Token purged but session cookie still present (post-restart / post-release) → agent routes return `401 "sign in again"`; panel routes back to sign-in.
- Takeover request when no holder → immediately acquire (no handshake).

## Testing

- Unit/integration: acquire when free; 409 for non-holder; request→deny keeps holder; request→release hands over + purges token; idle auto-release after `IDLE_LIMIT`; `lastActivityAt` bumps on agent actions; allowlist enforced; open-allowlist doctor warning.
- Web: in-use banner + request button; holder keep/hand-over prompt; idle state; setup copy/ordering.
- Manual (nexus-dev): two browsers/accounts — A holds + tweaks; B sees "in use", requests; A hands over; B acquires; idle-timeout path; A's token purged on release.

## Open questions (decide before implementing)

1. **Idle limit + grace defaults** — proposed 2h idle, 60s takeover grace. Confirm.
2. **Forced takeover of an *active* holder?** Proposed: never yank an actively-working holder; takeover only auto-grants once the holder is idle (holder can also voluntarily hand over). Confirm vs. an admin "force" override.
3. **Outgoing holder's uncommitted work on handover** — auto-checkpoint to their branch (preserve) vs. discard-to-base. Proposed: **auto-checkpoint** so nothing is lost, then reset the tree to base for the new holder.
4. **Booking persistence** — in-memory (restart releases) vs. persisted to config/disk (survives restart). Proposed: in-memory for simplicity.

## Related security follow-up: GitHub App migration (per-repo least privilege)

**Decided 2026-06-19** to do *alongside* this session hardening (both are "tighten the auth"). Implement after, or together with, the booking model.

**Problem:** the per-user OAuth model uses an **OAuth App with the `repo` scope** — all-or-nothing read/write to *every* repo the signing-in user can access (the consent screen lists all their orgs). The server-side allowlist limits what Tweaklet *does*, but the *grant* is broad — unacceptable for security-conscious orgs.

**Fix:** migrate from an OAuth App to a **GitHub App**:
- An admin **installs** the app on **selected repositories** only (e.g. just `Transcenda/t8a`), with **least-privilege** permissions: Contents (RW), Pull requests (RW), Metadata (R).
- Use **user-to-server** auth (the GitHub App also has a client id/secret + an OAuth-style authorize flow): the signed-in user authorizes, and the resulting token can only touch the **intersection of (repos the user can access) and (repos the app is installed on)** — so per-user attribution is **preserved** while access is scoped to the installed repo(s). The consent screen shows the app's permissions, not "all your repos."

**Changes:**
- `auth/github-oauth.ts` / callback: GitHub App user-to-server token exchange (same `code`→token shape, app credentials); scopes are governed by the app's permissions + installation, not a `scope` param.
- `config.ts`: replace the OAuth-App `github` block with a GitHub-App block (`appId`, `clientId`, `clientSecret`, optionally a private key only if server-to-server tokens are ever needed; user-to-server needs only client id/secret).
- Setup wizard "GitHub OAuth" step → "GitHub App": guide creating the App (permissions + callback) and **installing it on the allowlisted repos**; show the install URL.
- Git operations (`token-git.ts`/`clone.ts`/`pr.ts`) are unchanged — they already use whatever token the session holds.
- Docs: the operator creates + installs a GitHub App instead of an OAuth App.

**Interim (current state):** OAuth App + `repo` scope is in use; the allowlist constrains actual operations and the token is memory-only/purged. Acceptable for dev-box testing; the GitHub App is the production-grade scoping.

## Phase boundary

This is the single-instance booking model (one shared working tree, one holder at a time). **Still deferred beyond this:** true concurrent multi-user isolation (per-user worktrees / containers, branch registry) — only needed if multiple people must tweak *simultaneously*.
