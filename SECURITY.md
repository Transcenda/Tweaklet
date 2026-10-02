# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report it privately through GitHub:
**[Report a vulnerability](https://github.com/Transcenda/Tweaklet/security/advisories/new)**
(Security → Advisories → *Report a vulnerability*). Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- any affected versions / configuration.

Please don't include secrets or data from a real deployment in the report; a minimal
reproduction against a throwaway repository is ideal.

You'll get an acknowledgement within a few business days, and we'll keep you updated
as we investigate and ship a fix. We'll credit you in the release notes unless you
prefer to remain anonymous.

## Security model

Tweaklet is **self-hosted** and gives an AI agent write access to a cloned
repository under a signed-in user's own GitHub identity. What it guarantees:

- **Who gets in:** GitHub users with **write access to the configured
  repository**. This is checked with their own token at sign-in and re-checked
  while they use the server. An optional `access.allowedLogins` list narrows it
  further. When no repository is configured, nobody gets in.
- **One person at a time.** Whoever signs in holds the server until they sign
  out or go idle. On release their token is erased from memory.
- **Sessions** expire after 12 hours, can be revoked, and are scoped to the
  base path, `HttpOnly` and `Secure` on HTTPS. State-changing requests from
  other sites are refused.
- **Tokens** stay in memory and reach git only through a `GIT_ASKPASS` helper
  that answers only the configured host. Authenticated git runs with repo
  hooks, credential helpers and non-HTTPS transports disabled.
- **The agent** asks before every tool use, and Tweaklet's policy decides
  (`src/agent/decide.ts`). Edits are allowed only inside `guardrails.allow`,
  with symlinks resolved and `.git/` always refused. On shared servers, risky
  actions (shell commands outside the safe list, web access) are denied; they
  are never approvable from the browser. A PR is refused if it touches files
  outside the guardrails.
- **Local-only surfaces** (`/mcp`, `/auth/cli`) need a direct local
  connection; `/mcp` also needs a per-process token. opencode's own API
  requires a per-process password and listens on loopback only. The server
  itself listens on `127.0.0.1` by default.

## Known limitations

These are inherent to the current design. Please keep them in mind when you
deploy:

- **The widget shares the host app's origin.** Any script on the host page can
  do what the signed-in person can do in the panel: prompt the agent, make
  edits inside the guardrails, open a PR of those edits. It can't run commands
  on the server, because on shared servers those are never approvable from the
  browser. Treat Tweaklet like any tool embedded in your dev app, and keep it
  out of production builds.
- **Agent-written code runs in viewers' browsers.** Edits inside the guardrails
  are hot-reloaded into the dev app on the same origin. That is the point of
  the live preview, but it means a prompt-injected agent could ship hostile
  frontend code to whoever views the preview until a person reviews it. Keep
  the preview to a dev environment with dev data. For server-rendered
  frameworks, files under `src/` may also run on the server.
- **The agent runs as the same OS user as Tweaklet.** A shell command approved
  in ask mode, or a command you add to `agent.safeCommands`, can read
  Tweaklet's config (including its session secret) and the machine's cloud
  credentials. Prefer auto mode on shared servers. A dedicated OS user or
  container for the agent is on the roadmap.
- **The page reader sends page content to your model provider.** Values,
  hidden inputs, scripts and token-like strings are redacted, and every read is
  shown in the panel. Visible text is still sent, so don't point Tweaklet at
  pages showing data you can't send to your provider.

Reports that break any guarantee above are especially welcome.

## Supported versions

Tweaklet is pre-1.0 and ships from `main`. Security fixes land on `main`; please run
a recent build.
