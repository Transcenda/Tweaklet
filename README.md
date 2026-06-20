# Tweaklet

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

**Everyone is a builder now — describe a change for an AI agent, see it instantly in the running app, and ship it as a PR.**

Tweaklet is an AI panel that lives inside your app. Point at something, say what you want changed in plain words, and watch it happen in the running app — then ship it as a pull request. Engineers build the harness — the repo, the agent, the guardrails, the review flow — and everyone else builds on top of it.

```text
Make this button match the primary CTA from the checkout page.
Move this filter above the table and make it work on mobile.
Rewrite this empty state to sound less technical, and add a secondary action.
```

## Why

The smallest changes wait the longest. A copy fix, a spacing tweak, a tooltip — minutes of real work, stuck in a queue behind everything bigger, handed from product to design to QA to engineering until someone finally has time.

Tweaklet skips the queue. The person who spots the change makes it — describes it, sees it in the running app, iterates until it's right — and ships it as a PR through the same quality gates your team already trusts.

- **Product managers** — ship the small improvements you'd normally write a ticket for.
- **Designers** — refine the real UI, not just the mockup.
- **QA** — fix the broken state you found, with full page context.
- **Founders & stakeholders** — try copy, layout, and UX ideas without pulling engineers off their work.
- **Engineers** — give the team a safe way to contribute, and keep control of architecture, code quality, and releases.

## How it works

`Any app → embedded panel → plain-English request → Tweaklet server → proposed change → PR`

1. **Embed the widget** — one script tag, in any app (React, Vue, Angular, Next.js, Rails, Django, static HTML, internal tools).
2. **Ask in plain words**, pointing at the part of the UI you mean. Tweaklet captures the context — route, element, DOM, screenshot, design tokens — and you decide how much.
3. **It runs on your server** — auth, guardrails, your repo, and sandboxed agent execution all live on the Tweaklet server you host, so changes never leave your infrastructure.
4. **Review before it ships** — `Prompt → Patch → Preview → Review → PR → CI → Merge`. A human stays in the loop for production.

Early and moving fast — but the core loop works today.

## Getting started

See **[docs/INSTALL.md](docs/INSTALL.md)** for the full bootstrap, reverse-proxy snippets (Caddy / nginx), and Vertex AI setup.

```bash
npm i -g https://github.com/Transcenda/Tweaklet/releases/latest/download/tweaklet-server.tgz
tweaklet serve                                      # default port 4319
```

Expose `/tweaklet/*` through your reverse proxy and open `https://<your-host>/tweaklet/` — the Setup Wizard handles GitHub OAuth, Vertex, and the repo. On a dev machine that already has `git`, `opencode`, `gcloud` ADC, and `gh`, `tweaklet serve` auto-detects everything and starts with no config at all.

### Embed the widget

Add one `<script>` tag to your app's global entry document — the same way you'd add Google Analytics:

```html
<!-- Tweaklet AI tweak panel -->
<script src="/tweaklet/widget.js"></script>
```

The widget derives its server base from its own `src` at runtime; your reverse proxy just needs to forward `/tweaklet/*` to the Tweaklet server so the widget shares your app's origin.

**Dev-only gating (Vite)** — load it in development, never in a production build, with no `.env` file:

```html
<script type="module">
  const url = import.meta.env.VITE_TWEAKLET_URL || (import.meta.env.DEV ? "/tweaklet" : "");
  if (url) { const s = document.createElement("script"); s.src = url + "/widget.js"; s.async = true; document.body.appendChild(s); }
</script>
```

Proxy `/tweaklet` to the server in dev (`vite.config.ts` → `server.proxy`: `"/tweaklet": "http://127.0.0.1:4319"`). For Next.js, gate on `process.env.NEXT_PUBLIC_TWEAKLET_URL`. Per-framework details — plus an `install-tweaklet-widget` skill for Claude Code that wires this up for you — are in **[docs/INSTALL.md](docs/INSTALL.md)**.

## Development

```bash
npm test                  # server unit tests
npm --prefix web test     # web unit tests
```

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)**. Found a security issue? Please follow **[SECURITY.md](SECURITY.md)** (don't open a public issue).

## License

[MIT](LICENSE) © Transcenda
