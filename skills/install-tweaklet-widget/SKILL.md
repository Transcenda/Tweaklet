---
name: install-tweaklet-widget
description: Use when a developer wants to embed/install the Tweaklet AI tweak panel into a web app — finds the app's entry document and inserts the drop-in widget <script> (Google-Analytics style), with per-environment gating.
---

# Install Tweaklet Widget

This skill embeds the Tweaklet AI tweak panel into a host web app. The install pattern is identical to Google Analytics or Intercom: one `<script>` tag in the global entry document. No build pipeline changes are required for the basic install.

## How the widget works

The widget is served by the Tweaklet server at `<basePath>/widget.js` (default `/tweaklet/widget.js`). It is loaded with a **relative** URI — the widget derives its own server base URL from `document.currentScript.src` at runtime, so no API URL needs to be hard-coded in the tag. The host app's reverse proxy must forward `/tweaklet/*` to the Tweaklet server (port 4319 by default).

The drop-in snippet:

```html
<!-- Tweaklet AI tweak panel -->
<script src="/tweaklet/widget.js"></script>
```

**Reverse-proxy requirement:** The host origin must forward `/tweaklet/*` to the Tweaklet server so the widget, panel assets, and agent API all share the same origin as the host app. See the Caddy / nginx snippets in `docs/INSTALL.md`.

**Running the server:** the Tweaklet server installs straight from the GitHub repo and bundles `widget.js`: `npm i -g github:Transcenda/Tweaklet#v0.0.1 && tweaklet serve`, then finish setup in the browser. Full guide: `docs/INSTALL.md`. This skill only inserts the client `<script>`; a running server is a prerequisite.

---

## Step A — Locate the entry document

Search for the single global document that every page of the host app loads. Check in this order:

1. **Vite / Create React App / Vue CLI / plain static** — `index.html` at the repo root, or in `public/`, or in `src/`.
2. **Next.js App Router** — `app/layout.tsx` (or `app/layout.jsx`). Insert inside the `<head>` element or just before the closing `</body>` of the returned JSX. If using Pages Router instead, look for `pages/_document.tsx` (or `_document.jsx`) and insert in the `<Head>` or `<body>` section.
3. **SvelteKit** — `src/app.html`. Insert before `</body>`.
4. **Server-rendered templates:**
   - Rails: `app/views/layouts/application.html.erb`
   - Django: `templates/base.html` (or whichever base template wraps the full page)
   - Laravel: `resources/views/layouts/app.blade.php`

Pick the **single** file that wraps every page. Do not add the tag to individual page templates.

---

## Step B — Insert idempotently

Before editing, check whether a `tweaklet/widget.js` script is already present in the file. Search for the string `tweaklet/widget.js`.

- **Already present** — do nothing; the widget is already installed. Tell the developer it is already embedded and skip to Step D.
- **Not present** — insert the snippet.

Insert location: just before `</body>` (preferred), or in `<head>` with `async` if a `</body>` is not available (e.g. Next.js App Router `<head>` block).

Static snippet (no environment gating):

```html
<!-- Tweaklet AI tweak panel -->
<script src="/tweaklet/widget.js"></script>
```

---

## Step C — Per-environment gating (load in dev, skip in prod)

The static tag above will attempt to load the widget on every environment. For most teams the right policy is: load in development, not in production. Apply framework-appropriate gating:

### Vite (React / Vue / plain)

Replace the static `<script>` tag with an inline module that reads an env variable:

```html
<!-- Tweaklet AI tweak panel (dev only) -->
<script type="module">
  const url = import.meta.env.VITE_TWEAKLET_URL;
  if (url) {
    const s = document.createElement("script");
    s.src = url + "/widget.js";
    s.async = true;
    document.head.appendChild(s);
  }
</script>
```

Set `VITE_TWEAKLET_URL=/tweaklet` in `.env.development` (or `.env.local`) and leave it unset in `.env.production`. When the variable is absent the snippet is a no-op.

### Next.js (App Router)

Gate on `process.env.NEXT_PUBLIC_TWEAKLET_URL` in `app/layout.tsx`:

```tsx
{process.env.NEXT_PUBLIC_TWEAKLET_URL && (
  <script
    src={`${process.env.NEXT_PUBLIC_TWEAKLET_URL}/widget.js`}
    async
  />
)}
```

Set `NEXT_PUBLIC_TWEAKLET_URL=/tweaklet` in `.env.development` and omit it from production env.

### Next.js (Pages Router — `_document.tsx`)

Same pattern inside `<Head>` or `<body>`, gated on `process.env.NEXT_PUBLIC_TWEAKLET_URL`.

### SvelteKit

Use `import.meta.env.VITE_TWEAKLET_URL` (SvelteKit exposes Vite env vars); same snippet as the Vite pattern above.

### Server-rendered templates (Rails / Django / Laravel)

These frameworks do not expose build-time env vars to HTML templates the same way. Two options:

1. **Env check in the template** — render the tag only when `RAILS_ENV == "development"` (or the framework equivalent). Example for Rails ERB:
   ```erb
   <% if Rails.env.development? %>
     <!-- Tweaklet AI tweak panel -->
     <script src="/tweaklet/widget.js"></script>
   <% end %>
   ```
2. **No-op in prod** — add the static tag unconditionally. The widget will fail to load gracefully in production because `/tweaklet/*` will return a 404 (no reverse proxy configured for that path in prod); no errors will surface to end-users.

### Static HTML (no build tool)

Add the tag only to the dev copy of `index.html`, or use the no-op approach: add the tag unconditionally and simply do not run the Tweaklet server in production — the browser will silently ignore the 404.

---

## Step D — Verify

After editing the entry document, ask the developer to:

1. Restart / rebuild the dev app (`npm run dev`, `rails s`, etc.).
2. Open the app in a browser and confirm the Tweaklet launcher icon appears in the corner.
3. Complete the Tweaklet Setup Wizard's **"Verify in your app"** step — it will confirm the widget is reachable from the server side.

If the launcher does not appear, check:
- The reverse proxy is running and forwarding `/tweaklet/*` to the Tweaklet server.
- The env variable is set (if using the gated snippet).
- There are no browser console errors about a blocked or failed script load.

---

## Summary

- One `<script>` tag in the global entry document — no build-pipeline wiring required for basic install.
- URI is relative (`/tweaklet/widget.js`) — the widget derives its own base from `src` at runtime.
- Gate to dev-only using the env-var snippet appropriate for the host framework.
- Idempotent: if the tag is already present, do nothing.
- Reverse proxy (`/tweaklet/*` → Tweaklet server) is a prerequisite — confirm it is configured before telling the developer the install is complete.
