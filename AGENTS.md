# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, opencode, …) and
humans working **on Tweaklet itself**. Tweaklet is a public, MIT-licensed open
source project. Anyone may read every file, commit, issue and pull request, and
teams across many unrelated websites self-host it.

## Rule zero: this repository is public

Everything you write here (code, comments, tests, fixtures, docs, commit messages,
PR descriptions, issue comments, release notes) is published to the world and
kept forever in git history. Before you write anything, check it against these
rules. They apply to commit messages and PR text as much as to files.

### Never include

- **Secrets of any kind:** tokens, API keys, passwords, OAuth client secrets,
  session secrets, private keys, cookies, signed URLs. This includes values that
  "look like test data" but came from a real system.
- **Details of any real deployment:** hostnames, domains, IP addresses, cloud
  project IDs, regions/zones tied to a real host, VM or service names, bucket
  names, internal URLs, dashboards, log excerpts.
- **People and accounts:** real names, emails, GitHub logins or numeric IDs
  (other than the project's own maintainer metadata), Unix usernames, home
  directory paths (`/Users/<name>/…`, `/home/<name>/…`).
- **Other products and organisations:** no references to any company's internal
  tools, private repositories, customers, or the apps Tweaklet happens to be
  deployed on. Tweaklet must read as a general tool for *any* web app.
- **Session artefacts:** implementation plans, agent transcripts, scratch notes,
  local machine setup, and screenshots or recordings that show private data
  (real records, credentials, internal URLs).

### Use neutral placeholders instead

| Kind | Use |
| --- | --- |
| domain / URL | `example.com`, `app.example.com`, `http://localhost:4319` |
| repository | `acme/webapp` |
| GitHub user | `octocat` (id `583231`), `alice`, `bob` |
| cloud project | `my-gcp-project` |
| systemd unit | `webapp-dev` |
| paths | `/repo`, `/tmp/…`, `~/.tweaklet` |
| secrets in tests | obviously fake values (`"z".repeat(32)`, `"tok"`) |

### When you notice a leak

Don't copy it elsewhere. Remove it from the working tree in the same change, and
flag it to a maintainer. Anything that was ever pushed is in public history, so
a credential has to be **rotated**; deleting it is not enough. Report
security-sensitive findings privately (see [SECURITY.md](SECURITY.md)), never in
a public issue.

## Project map

- `src/`: `@tweaklet/server`, a Node ≥ 20 / Express / TypeScript (ESM) server.
  It handles auth, the opencode agent driver, the git change workspace, the
  live preview, the setup wizard API and diagnostics.
- `web/`: the React + Vite widget, built as a single self-mounting
  `web/dist/widget.js` (Shadow DOM, no iframe).
- `skills/`: an agent skill that installs the widget into a host app.
- `docs/`: [ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it works, the security
  model) and [INSTALL.md](docs/INSTALL.md) (operator guide).

Read `docs/ARCHITECTURE.md` before changing auth, guardrails, git operations or
the tree lock.

## Commands

```bash
npm ci && npm --prefix web ci     # install
npm run typecheck                 # server types
npm test                          # server tests (Vitest)
npm --prefix web test             # widget tests (Vitest + Testing Library)
npm run build:all                 # server + widget bundle
```

Git-level tests create real temporary repos and can be slow on a busy machine.
Raise the per-test timeout (`npx vitest run --testTimeout=60000`) rather than
weakening the tests.

## Conventions

- **Tests first, at the lowest useful layer.** Git behaviour is tested against a
  real bare `origin` and clone, routes with `supertest` and injected
  `ServerDeps`, and the panel with Testing Library. Test what users observe.
- **Security invariants are not negotiable.** OAuth tokens stay in memory and
  reach git only through `GIT_ASKPASS`. Every ref from a request goes through
  `assertSafeRef`. Git is invoked with argv arrays, never a shell. Loopback-only
  routes stay loopback-only. Nothing may discard a user's unsaved work.
- Match the surrounding style: TypeScript strict, small modules, comments that
  explain *why*.
- Keep the public surface generic. New config options need a neutral example in
  `docs/INSTALL.md`.
- Every user-visible change gets a `CHANGELOG.md` entry.

## Pull requests

- Use one logical change per PR, with a topic branch such as `feat/<slug>`,
  `fix/<slug>` or `docs/<slug>`.
- CI (typecheck, tests, build) must pass.
- Write the description for an outside reader: what changed and why, and how
  it was verified. Mention no private deployments.
- Releases are cut by pushing a `vX.Y.Z` tag. The workflow builds and publishes
  the tarball.
