# Tweaklet — Per-user, UI-driven GitHub auth (design)

**Status:** approved (design) · 2026-06-18
**Supersedes:** the operator-side `gh auth login` + `git config` setup steps and
their doctor checks (`github cli` auth, `git identity`) introduced earlier on
`feat/tweaklet-pluggable-onboarding`. Those become unnecessary under this model.

## Goal

A **non-technical end user authenticates and operates entirely through the web
UI under their own GitHub account** — clone, commit, and open PRs — with **no
`gh auth login`, no `git config`, no SSH, ever**. The only CLI is the developer's
one-time server deploy.

Today the wizard's OAuth sign-in stores only `{login, id}` for access control and
**discards the access token**; all git work runs under a single server-side `gh`
CLI identity + `git config` that an operator sets once over SSH. That gives no
per-user attribution and pushes GitHub-CLI friction onto whoever runs setup.

## Decisions (locked during brainstorming)

1. **Per-user identity** — git clone/commit/PR run under the **signed-in user's
   OAuth token**, not a shared service account. Attribution is per-person.
2. **OAuth App + `repo` scope** — keep the existing OAuth App the wizard sets up;
   add `repo` (+ `read:user`, `user:email`) so the user's token can clone the
   private repo, commit, and push. (Not a GitHub App — coarser scope, but far
   simpler; the server-side allowlist still constrains *which* repo is touched.)
3. **One active user at a time** — per-user identity/attribution on a **single
   shared working tree**. Concurrent multi-user (per-user worktrees, session
   lock/booking) stays the deferred **Phase 2**.
4. **Drop `gh`** — git operations use the token via `GIT_ASKPASS`; PRs use the
   GitHub REST API. The `gh` binary, `gh auth`, and `git identity` leave setup.

## 1. Identity & token lifecycle

- **OAuth scopes:** `buildAuthorizeUrl` requests `repo read:user user:email`.
- **Sign-in:** unchanged popup OAuth flow (`/auth/login` → GitHub → `/auth/callback`).
- **Callback:** exchange `code` → access token; fetch the GitHub user
  (`login`, `id`, `name`, `email` — `user:email` yields a usable commit email,
  falling back to the GitHub `noreply` email if the user hides it). **Store**
  `{ token, login, id, name, email }` in a **server-side in-memory session store
  keyed by the session id**. The session cookie stays the signed, httpOnly
  `{login, id}` (as today).
- **The token never:** goes into a cookie, is written to disk/`.git/config`, or
  is logged. Lost on server restart → the user simply signs in again (acceptable
  for a single instance).
- **Logout / restart:** clears the stored token.
- **Access control:** `access.allowedLogins` / `allowedUserIds` unchanged.

## 2. Git operations (per request, with the session's token)

A small `tokenGit` helper resolves the current session's token and runs git with
it injected ephemerally:

- **Clone (first use):** `git clone https://github.com/<owner>/<name>` with
  `GIT_ASKPASS` pointing at a tiny helper that emits `x-access-token` + the token
  (env-passed, not on the command line). The token is **never persisted** in the
  cloned repo's config. Clones into `repo.path` (single working tree). The
  allowlist + `parseRepoRef` safety from the current `clone.ts` are retained.
- **Commit:** `git -c user.name="<oauth name>" -c user.email="<oauth email>"
  commit …` so each commit is authored as the signed-in user (no global
  `git config` needed).
- **Fetch / push:** same `GIT_ASKPASS` token injection.
- **PR:** GitHub REST `POST /repos/{owner}/{repo}/pulls` with
  `Authorization: Bearer <token>` → PR opened as the user (replaces `gh pr create`).

## 3. Setup wizard (operator) — simplified

- **Dependencies:** `node ≥20`, `git`, opencode-server-responds, widget bundle,
  package manager, publicUrl. **Removed:** `github cli` (auth) and `git identity`
  checks; the `gh` binary is no longer a dependency.
- **GitHub OAuth:** operator pastes Client ID/Secret; the wizard shows the
  callback URL **and the required scopes** to grant on the OAuth App.
- **AI agent:** Vertex project/location/model (unchanged; GCE-ADC aware).
- **Repository:** operator configures the **allowlist** of permitted repos — **no
  clone here**.
- **Finish:** operator marks setup complete.

## 4. Usage (end user) — UI only

Sign in (OAuth popup) → pick an allowlisted repo → Tweaklet clones it with the
user's token (first use) → tweak panel → edits become commits authored as the
user → **Ship** opens a PR authored by the user. No CLI/SSH at any point.

Wizard/flow ordering changes so **sign-in precedes repo selection** for the end
user (the clone needs the token).

## 5. Components touched

| Unit | Change |
|---|---|
| `auth/github-oauth.ts` + `/auth/callback` | request scopes; capture token + name/email |
| (new) `auth/session-store.ts` | in-memory `sessionId → {token,login,id,name,email}` |
| `repo/clone.ts` | token-injected `git clone` via `GIT_ASKPASS`; drop `gh`; keep allowlist + `parseRepoRef` |
| `git/repo.ts` | commit with per-user author; push with token |
| `git/pr.ts` | REST PR creation with the token (drop `gh`) |
| `doctor/doctor.ts` | remove `github cli` (auth) + `git identity` checks; drop `gh` presence |
| `server/setup-state.ts` | `depsOk` no longer requires gh/identity |
| web wizard | repo step → allowlist config (operator); clone moves post-sign-in; sign-in before repo |
| `config/config.ts` | OAuth scopes; `repo.path` still the working tree |

## 6. Error handling

- **Token missing/expired** (e.g. after restart): git/PR ops return a clear
  "please sign in again" error; the panel routes back to sign-in.
- **Repo not in allowlist:** rejected server-side (unchanged).
- **Clone/push auth failure:** surfaced with the GitHub message; never leaks the
  token.
- **Hidden email:** fall back to the `@users.noreply.github.com` commit email so
  commits never fail for lack of identity.

## 7. Security

- `repo` is coarse (the token can read all repos the user can access), but the
  **server-side allowlist** limits which repo Tweaklet operates on.
- Token kept **in-memory only**; never persisted, logged, cookie-stored, or
  written to `.git/config`. Injected per-invocation via `GIT_ASKPASS`.
- HTTPS-only (same-origin behind Caddy). Cleared on logout/restart.

## 8. Testing

- **Unit:** `GIT_ASKPASS` helper emits the right username/token; commit uses the
  OAuth author; PR REST payload shape + auth header; doctor no longer emits
  gh-auth/git-identity; allowlist still enforced by `clone.ts`.
- **Integration:** callback stores the token; clone runs with an injected exec
  carrying the token; PR posts to a mocked REST endpoint; token absent → 401-ish
  "sign in again".
- **Manual (nexus-dev):** sign in → clone t8a as the user → tweak → PR shows the
  user as author.

## 9. Phase 2 (still deferred)

Concurrent multi-user: per-user worktrees, branch registry, session lock /
booking, idle timeout.
