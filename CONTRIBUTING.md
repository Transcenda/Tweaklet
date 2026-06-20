# Contributing to Tweaklet

Thanks for your interest in Tweaklet! Everyone is a builder now — and that includes
contributors. This guide gets you set up and explains how we work.

## Project layout

Tweaklet is a small TypeScript monorepo:

- `src/` — `@tweaklet/server`: the Node/Express server (auth, agent orchestration via
  the opencode SDK, the DOM-inspect MCP, git/PR flow, the setup wizard API).
- `web/` — `@tweaklet/widget`: the React/Vite self-mounting Shadow-DOM widget + panel.
- `skills/` — the bundled `install-tweaklet-widget` Claude Code skill.
- `docs/` — design specs (`docs/specs/`), implementation plans (`docs/plans/`), and
  the operator guide (`docs/INSTALL.md`).

## Getting set up

Prerequisites: Node LTS (≥ 20), and [opencode](https://opencode.ai) on your `PATH`
for running the agent locally.

```bash
git clone https://github.com/Transcenda/Tweaklet.git
cd Tweaklet
npm install && npm run build          # server
npm --prefix web install && npm --prefix web run build   # widget
```

See [docs/INSTALL.md](docs/INSTALL.md) for running it end-to-end (reverse-proxy
snippets, Vertex AI / model setup, embedding the widget).

## Development workflow

- **Tests are required.** Add tests at the lowest layer that covers the change:
  - server: `npm test` (Vitest; routes use the SQLx-style auto-isolation patterns in `src/**/*.test.ts`)
  - widget: `npm --prefix web test` (Vitest + Testing Library)
- **Type-check + build** before pushing: `npm run build` and `npm --prefix web run build`.
- Keep changes focused; one logical change per PR.
- Match the surrounding code style (the repo uses TypeScript strict mode; no extra
  formatter config beyond what's committed).

## Pull requests

1. Fork (or branch) and create a topic branch: `feat/<short-slug>` or `fix/<short-slug>`.
2. Make your change **with tests**; run the server + widget test suites locally.
3. Open a PR against `main` with a clear description of the what and why.
4. CI must be green and at least one maintainer review is required before merge.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/Transcenda/Tweaklet/issues). For security
issues, **do not** open a public issue — see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
