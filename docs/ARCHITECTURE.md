# Tweaklet architecture

A summary of how the pieces fit, what each one guarantees, and where to look in
the code. For installing and operating a server, see [INSTALL.md](INSTALL.md).
The design specs in [specs/](specs/) hold the detail behind each area: the
business requirements, the UX, and the decisions with their rationale. Each one
starts with a status line saying how current it is.

## The pieces

```
 host app (any web app)                 Tweaklet server (you host it)              your git host
┌──────────────────────┐   /tweaklet/*  ┌─────────────────────────────────┐        ┌──────────┐
│ <script widget.js>   │ ─────────────▶ │ Express API  (src/server)       │  OAuth │ GitHub   │
│  Shadow-DOM panel    │ ◀── SSE ────── │  ├─ auth: per-user GitHub OAuth │ ◀────▶ │  clone / │
│  (web/src)           │                │  ├─ change workspace (src/git)  │        │  push /  │
└──────────────────────┘                │  ├─ agent driver (src/agent) ───┼──┐     │  PR      │
          ▲                             │  └─ live preview (src/run)      │  │     └──────────┘
          │ HMR                         └─────────────────────────────────┘  │
┌──────────────────────┐                     shared clone of your repo ◀─────┘ opencode server
│ host dev server      │ ◀── serves files from the clone the agent edits      (loopback only)
└──────────────────────┘
```

- **Widget** (`web/`): one self-contained `widget.js` that mounts the panel into a
  Shadow root inside the host page. No iframe and no build-time config: it
  derives its server base from its own `src`. It docks beside the app, captures
  page context (route, picked elements), and answers DOM queries from the agent.
- **Server** (`src/`): an Express app mounted under `server.basePath`
  (default `/tweaklet`). It handles auth, the setup wizard, the change lifecycle,
  and streams agent events to the panel over SSE.
- **Agent:** an [opencode](https://opencode.ai) server driven through
  `@opencode-ai/sdk`. Tweaklet owns the process, which binds a fixed loopback
  port, so there is one per host. Every prompt uses the host repo's
  `assistant` agent.
- **Shared clone:** one working copy of the target repo per host. The agent
  edits it, and the host app's dev server serves from it, so changes appear live.

## Identity and access

- **Per-user GitHub OAuth.** Each person signs in with their own GitHub account.
  Their token stays **in server memory only**. It is never written to disk, logged,
  or placed on a command line, and git receives it through a private
  `GIT_ASKPASS` helper (`src/git/token-git.ts`). Commits and pull requests are
  authored as that user. A restart drops the tokens, so `/agent/me` reports
  `needsReauth` and the panel asks the user to reconnect.
- **One active user at a time.** Whoever signs in holds the server, so every
  action runs under one identity. Anyone else is refused at sign-in, with a
  note saying when the server frees up, until the holder signs out or goes idle
  (`session.idleMinutes`, default 30; a running agent counts as activity). On
  release the holder's token is erased and their session stops counting.
- **Sessions** are signed, purpose-tagged and expire after 12 hours. Logout
  revokes them on the server. The cookie is `HttpOnly`, `SameSite=Lax`,
  `Secure` on HTTPS, and scoped to the base path.
- **Local CLI sign-in** (`/auth/cli`) reuses an authenticated `gh` CLI on a
  developer's own machine. It only works for a direct local request (never one
  relayed by a proxy), and it's off when GitHub OAuth is configured.
- **Who may sign in follows GitHub:** write access to the configured repository
  (the cloned one, or one on `repo.allowlist` before cloning), checked with the
  user's own token at sign-in and every 10 minutes while they hold the server.
  With no repository configured, nobody gets in. `access.allowedLogins` /
  `allowedUserIds` optionally narrow it further. **Repo allowlist**
  (`repo.allowlist`) limits which repositories may be cloned; users pick from
  the list and never type a URL.
- **Setup token:** until setup completes, the wizard's API requires a one-time
  token printed in the server log.

## Agent guardrails

Tweaklet launches opencode with an inline config that makes it **ask before
every tool use**. Inline config overrides the host repo's own `opencode.json`
and `.opencode/` agents, so a repository can't loosen this. Tweaklet answers
each request itself (`src/agent/decide.ts`):

| Request | Auto mode (default on shared servers) | Ask mode (default locally) |
| --- | --- | --- |
| read, search, list, LSP, todos | allowed | allowed |
| edit inside `guardrails.allow` | allowed | allowed |
| edit outside it, or with no paths | **denied** | **denied** |
| sub-agents (`task`), files outside the repo | **denied** | **denied** |
| shell command on `agent.safeCommands` (exact match, no shell operators) | allowed | allowed |
| any other shell command, web fetch/search, anything new | **denied**, explained in the panel | the person decides (Allow / Deny) |

**Why auto on shared servers:** the panel runs inside the host page, and any
script there could click Allow, including code the agent itself writes and
hot-reloads. Same-origin JavaScript can't prove a human pressed the button, so
on a server with GitHub sign-in the browser never approves risky actions; the
server decides. Ask mode, for a developer's own machine, is the default when
GitHub sign-in isn't configured, and can be chosen with `agent.approvals`. The
default safe list holds read-only git, typecheck and lint. Tests are left off
because they run test files the agent can write.

As defence in depth, the panel mounts in a **closed** shadow root and keeps
its own copy of `fetch` from boot, so ordinary page scripts can't reach into
it or intercept its requests.

Out-of-bounds edits never touch the tree, so there is nothing to revert.
**Stop** aborts the session. The DOM-inspect MCP endpoint (`/mcp`) that lets the
agent read the user's live page needs a per-process token and a direct local
connection.

## Change workspace

Every change lives on its own branch named `<branchPrefix><slug>`.
`src/git/repo.ts` implements the lifecycle:

- **Start:** settle the tree, fetch `origin/<base>`, hard-reset the local base to
  it, and cut a uniquely named branch. The branch records a human title and its
  owner in git config. A prompt sent while on the base starts a change
  automatically, so the agent never edits the base.
- **Never lose work:** before HEAD moves, unsaved edits on a change are
  auto-saved as a commit that skips repo hooks. If saving fails, the operation
  stops rather than discarding anything. Commits that exist only on the local
  base are moved to a "Recovered work" change before the base is reset.
- **Switch / delete:** the panel's change switcher lists every change with its
  saves and state. Only the change's owner may delete it. Each change keeps its
  own agent conversation (sessions are keyed per user and branch).
- **Saves and submit:** a save is a commit on the change. Preview and restore move
  between earlier saves without rewriting history. Submit opens a draft PR as
  the user.
- **One writer at a time:** a single lock covers every operation that moves HEAD or
  rewrites files. Prompts are refused while it's held, and while previewing an
  earlier save.

## Live preview

When `preview` is configured, Tweaklet keeps the host app's dev server in step
with the clone (`src/run/preview.ts`):

- It installs dependencies when `node_modules` is missing **or the lockfile
  changed** since the last install, tracked with a stamp file.
- It restarts the dev-server unit only when something changed or the unit isn't
  running. A running dev server picks up checked-out files through HMR.
- It runs at server start (so it recovers after a reboot) and after every
  start/switch/delete. Calls are serialised, and the doctor reports a stopped
  preview.

## Configuration

Zero-config is a design principle. The widget needs only its script tag, and
`tweaklet serve` inside a git repo starts with no config file at all. Every
option has a default or is detected, and optional features stay off until
configured.

Everything lives in `~/.tweaklet/config.json`, which is mode `0600` and
validated by `src/config/config.ts`. `tweaklet serve` with no config
auto-detects what it can (repo, base branch, opencode, cloud project, `gh`
identity) and writes one you can edit. Run the doctor (the panel's status menu,
or `GET /agent/doctor`) to see what's missing and how to fix it.

## Source map

| Path | What |
| --- | --- |
| `src/server/server.ts` | routes, auth gates, the tree lock, SSE |
| `src/agent/` | opencode driver, permission decisions, history, DOM-inspect MCP |
| `src/git/` | change lifecycle, token-scoped git, PR creation, ref validation |
| `src/repo/clone.ts` | allowlisted clone |
| `src/run/` | live preview and refresh |
| `src/doctor/` | diagnostics shown in the wizard and the panel |
| `web/src/Panel.tsx` | the panel and change switcher |
| `web/src/SetupWizard.tsx` | first-run setup |
