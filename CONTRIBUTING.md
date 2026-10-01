# Contributing to Tweaklet

Thanks for your interest in Tweaklet! Everyone is a builder now — and that includes
contributors. This guide gets you set up and explains how we work.

## Project layout

Tweaklet is a small TypeScript monorepo:

- `src/` — `@tweaklet/server`: the Node/Express server (auth, agent orchestration via
  the opencode SDK, the DOM-inspect MCP, git/PR flow, the setup wizard API).
- `web/` — `@tweaklet/widget`: the React/Vite self-mounting Shadow-DOM widget + panel.
- `skills/` — the bundled `install-tweaklet-widget` agent skill.
- `docs/` — [ARCHITECTURE.md](docs/ARCHITECTURE.md) (summary: how it works, security
  model), [specs/](docs/specs/) (design specs: business requirements, UX, decisions),
  and [INSTALL.md](docs/INSTALL.md) (operator guide).

## Getting set up

Prerequisites: Node LTS (≥ 20), and [opencode](https://opencode.ai) on your `PATH`
for running the agent locally.

```bash
git clone https://github.com/Transcenda/Tweaklet.git
cd Tweaklet
npm ci && npm --prefix web ci
npm run build:all                     # server + widget
```

See [docs/INSTALL.md](docs/INSTALL.md) for running it end-to-end (reverse-proxy
snippets, Vertex AI / model setup, embedding the widget).

## Development workflow

- **Tests are required.** Add tests at the lowest layer that covers the change:
  - server: `npm test` (Vitest; git behaviour against real temporary repos, routes
    via `supertest` with injected dependencies)
  - widget: `npm --prefix web test` (Vitest + Testing Library)
- **Type-check + build** before pushing: `npm run typecheck` and `npm run build:all`.
- Keep changes focused; one logical change per PR.
- **New features start with a design spec** in `docs/specs/` (problem, business
  requirements, UX, design, non-goals). See [AGENTS.md](AGENTS.md#design-specs).
- Match the surrounding code style (the repo uses TypeScript strict mode; no extra
  formatter config beyond what's committed).
- **This repository is public.** Never commit secrets, details of a real deployment
  (hosts, IPs, cloud project IDs), personal data, or references to other
  organisations' systems — in files, commit messages, or PR text. Use the neutral
  placeholders listed in [AGENTS.md](AGENTS.md).
- Add a `CHANGELOG.md` entry for anything user-visible.

## Pull requests

1. Fork (or branch) and create a topic branch: `feat/<short-slug>` or `fix/<short-slug>`.
2. Make your change **with tests**; run the server + widget test suites locally.
3. Open a PR against `main` with a clear description of the what and why.
4. CI (typecheck, tests, build) must be green and a maintainer review is required
   before merge. PRs are squash-merged.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/Transcenda/Tweaklet/issues). For security
issues, **do not** open a public issue — see [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
