# Tweaklet

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

**Everyone is a builder now — describe a change, see it in the running app, and ship it as a PR.**

Tweaklet is an AI panel that lives inside your app. Point at something, say what you want changed, watch it happen in the running app — then ship it as a pull request.

Engineers build the harness — the repo, the agent, the guardrails, the review flow. Everyone else builds on top of it.

---

## What is Tweaklet?

Tweaklet is a widget that embeds in your app and opens as a panel. Pick a part of the UI, describe the change in plain words, and the AI agent proposes the edit.

Example prompts:

```text
Make this button match the primary CTA style from the checkout page.
Move this filter above the table and make the layout work better on mobile.
Change this empty state copy to sound less technical and add a secondary action.
Make this form more compact, but keep all validation messages visible.
```

Every request runs through your repository, your design rules, and your guardrails — the agent works inside them, never around them.

## Why Tweaklet?

The smallest changes wait the longest. A copy fix, a spacing tweak, a tooltip — minutes of real work, stuck in a queue behind everything bigger, passed between product, design, QA, and engineering until someone has time.

Tweaklet skips the queue. The person who spots the change makes it — describe it, see it in the running app, iterate until it's right — and ships it as a PR. No handoff. The same quality gates your team already trusts.

## Who is it for?

- **Product managers** — ship the small improvements you'd normally write a ticket for.
- **Designers** — refine the real UI, not just the mockup.
- **QA** — fix the broken state you found, with full page context.
- **Founders & stakeholders** — try copy, layout, and UX ideas without pulling engineers off their work.
- **Engineers** — give the team a safe way to contribute, and keep control of the architecture, code quality, and release flow.

## Core idea

Tweaklet separates **who can suggest changes** from **who controls how changes are implemented**.

Non-technical users get a simple interface ("Make this screen easier to understand"). Engineers define the real operating boundaries: which files the agent can edit, which components can change, which design-system rules apply, which APIs/data models are allowed, which environments are used, and whether changes become previews, patches, pull requests, or tickets — and what requires human approval.

## How it works

1. **Embed the widget** — a lightweight frontend widget dropped into any app (React, Vue, Angular, Next.js, Rails, Django, Laravel, static HTML, internal tools, admin panels, SaaS, enterprise apps).
2. **Capture UI context** — current route, selected element, DOM metadata, screenshot/visual state, component hints, user role, environment, viewport, design tokens, product instructions. Exactly what's captured is configurable by the engineering team.
3. **Send the request to the Tweaklet server** — which owns auth, authorization, rate limits, prompt construction, guardrails, codebase access, sandbox execution, agent orchestration, logging/audit, preview generation, and PR/ticket creation.
4. **Generate a proposed change** — UI copy, CSS, component layout, design-system-aligned changes, accessibility/responsive fixes, frontend component updates, tests when needed, and PRs/patches/notes.
5. **Review before shipping** — `Prompt → Proposed patch → Preview → Review → Pull Request → CI → Merge → Deploy`. For production SaaS, keep human review in the loop.

## What Tweaklet is not

- Not a generic chatbot.
- Not a replacement for designers or engineers.
- Not a no-code platform.

It is an embedded product-iteration interface backed by your own self-hosted agent and infrastructure.

## Guardrails

Tweaklet is designed to work with strict guardrails: read-only / preview-only modes, component/file/route allowlists, design-token-only changes, no API/DB/dependency changes, no production deployment, required engineer approval, required CI pass, required visual-regression check.

## Example usage

```js
import { Tweaklet } from "@tweaklet/widget";

Tweaklet.init({
  appId: "my-product",
  environment: "staging",
  apiUrl: "https://tweaklet.example.com/api",
  user: { id: "user_123", role: "product_manager" },
  context: { route: window.location.pathname, captureDom: true, captureScreenshot: true },
});
```

## Status

Tweaklet is currently an experimental product concept. The initial goal is to validate the core workflow:

`Any app → Embedded panel → Natural-language UI request → Tweaklet server → Proposed change`

---

## Getting started

See **[docs/INSTALL.md](docs/INSTALL.md)** for the full bootstrap, reverse-proxy snippets (Caddy / nginx), and Vertex AI setup.

Short version:

```bash
npm install && npm run build
npm --prefix web install && npm --prefix web run build
node dist/index.js serve          # default port 4319
```

On first start the server prints a **setup token**. Expose `/tweaklet/*` via your reverse proxy, then open `https://<your-host>/tweaklet/` in a browser and enter the token — the Setup Wizard guides the rest (GitHub OAuth, Vertex, repo clone, guardrails).

### Embed the widget in your app

Add one `<script>` tag to your app's global entry document — the same way you'd add Google Analytics:

```html
<!-- Tweaklet AI tweak panel -->
<script src="/tweaklet/widget.js"></script>
```

The widget derives its server base from its own `src` at runtime (no build-time config). Your reverse proxy must forward `/tweaklet/*` to the Tweaklet server so the widget shares the same origin as your app.

**Dev-only gating (recommended):** Use an env-var guard so the widget loads in development but not production. Vite example:

```html
<script type="module">
  const url = import.meta.env.VITE_TWEAKLET_URL; // set in .env.development, absent in .env.production
  if (url) { const s = document.createElement("script"); s.src = url + "/widget.js"; s.async = true; document.head.appendChild(s); }
</script>
```

For Next.js gate on `process.env.NEXT_PUBLIC_TWEAKLET_URL`. Full framework-by-framework details are in **[docs/INSTALL.md](docs/INSTALL.md)**.

**Claude Code users:** run the `install-tweaklet-widget` skill to automate this — Claude will find your entry document and insert the snippet with appropriate per-environment gating.

Config lives in `~/.tweaklet/config.json` (0600). The agent runs key-less on Vertex via ADC.

### Branch naming

Tweaklet creates one feature branch per change, named from a convention you control in `~/.tweaklet/config.json`:

    "repo": { "branchPrefix": "tweaklet/", ... }

Branches are `<branchPrefix><slug-of-request>` (e.g. `tweaklet/make-header-bigger`). Set `branchPrefix` to match your team's convention (`tweaklet/`, `feature/`, `proposals/`, …). Non-technical users never name or pick branches — they Start a change, Save points (with a navigable history), and Submit for review.

### Development

```bash
npm test                  # server unit tests
npm --prefix web test     # web unit tests
```

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** to get set up,
run the tests, and open a PR. Found a security issue? Please follow
**[SECURITY.md](SECURITY.md)** (don't open a public issue).

## License

[MIT](LICENSE) © Transcenda
