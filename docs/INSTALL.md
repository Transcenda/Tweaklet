# Tweaklet — Install Guide

## Prerequisites

- **Node.js LTS (≥ 20)** — the only hard requirement to get the server running.
- `git` and `opencode` are needed for the full agent workflow; the in-browser Setup Wizard will guide you through installing and verifying each one after the server is up.
- **No `gh` CLI required** — git operations (clone, commit, PR) are performed using each end-user's own GitHub OAuth token, not a shared operator credential.

---

## Bootstrap

### Quick start (npm)

The published package bundles the server **and** the web panel:

```bash
npx @tweaklet/server serve                 # default port 4319
# …or install it:
npm install -g @tweaklet/server && tweaklet serve
```

### From source

```bash
git clone https://github.com/Transcenda/Tweaklet
cd Tweaklet
npm install && npm run build:all            # server + web panel
node dist/index.js serve                    # default port 4319
```

On first start while unconfigured the server prints a **setup token** to the log:

```
Tweaklet setup token: <token>
  (enter it in the setup wizard to configure this server)
```

Keep this token — you will need it in the next step. You can change the port with `--port <n>` (see `node dist/index.js serve --help`) or set `server.port` in `~/.tweaklet/config.json`.

---

## Expose `<basePath>/*` via reverse proxy

Tweaklet mounts everything — the widget, the panel, and the agent API — under a single URI prefix (default `/tweaklet`). Expose that path on your existing host origin so the widget and panel share the same origin as your app.

### Caddy

```caddy
handle /tweaklet/* {
    reverse_proxy localhost:4319
}
```

The prefix must reach the app intact (do **not** strip it). The app is mounted under `/tweaklet` and expects to see that prefix in the request path.

### nginx

```nginx
location /tweaklet/ {
    proxy_pass http://localhost:4319;
}
```

---

## Embed the widget in your app

Add a single `<script>` tag to your host app's global entry document — the same way you would add Google Analytics or Intercom:

```html
<!-- Tweaklet AI tweak panel -->
<script src="/tweaklet/widget.js"></script>
```

The script self-bootstraps: it mounts the Tweaklet UI into a Shadow root directly in the host page (no iframe), deriving all API URLs from its own `src` — no build-time configuration needed. SRI (`integrity="sha384-..."`) is optional here since `widget.js` is served same-origin from your own host, but you can add it as a hardening measure if desired.

**Reverse-proxy requirement:** The URI is relative (`/tweaklet/widget.js`). Your reverse proxy must forward `/tweaklet/*` to the Tweaklet server (configured in the previous section) so the widget, panel, and agent API all share the same origin as your app.

**Per-environment gating (dev on / prod off):** For frameworks with build-time env vars, gate the load so it only runs in development. Vite example — replace the static tag with:

```html
<script type="module">
  const url = import.meta.env.VITE_TWEAKLET_URL; // set in .env.development, unset in .env.production
  if (url) { const s = document.createElement("script"); s.src = url + "/widget.js"; s.async = true; document.head.appendChild(s); }
</script>
```

For Next.js gate on `process.env.NEXT_PUBLIC_TWEAKLET_URL`. For static / server-rendered apps without env vars, either add a server-side environment check or leave the tag unconditional — the browser silently ignores a 404 when the Tweaklet server is not running in production.

**Claude Code users:** run the `install-tweaklet-widget` skill (`/install-tweaklet-widget`) to have Claude find your entry document, insert the snippet, and apply the appropriate per-environment gating automatically.

---

## Vertex AI note (for the agent step)

`opencode` runs key-less via **Application Default Credentials (ADC)** on a GCP VM when the VM's service account has the `aiplatform.user` role.

Off GCP, either:

```bash
gcloud auth application-default login
```

or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file.

The Setup Wizard's **Vertex / agent** step checks for ambient credentials and will show you what to fix if they are missing.

---

## Complete setup via the wizard

Open `https://<your-host>/tweaklet/` in a browser. You will be prompted for the setup token printed in step 3 above. Enter it, and the wizard guides the rest:

1. **Dependencies** — verifies `git`, `opencode`, and your Node version. Shows the distro-specific install command for anything missing; click **Re-check** after each install. (`gh` CLI is not required or checked.)
2. **GitHub OAuth** — walks you through creating a GitHub OAuth App with scopes `repo read:user user:email` and saving the credentials. The exact callback URL (`<publicUrl>/tweaklet/auth/callback`) is shown for copy-paste.
3. **Vertex / agent** — captures your GCP project, location, and model; verifies credentials.
4. **Repository** — configure the **repo allowlist**: one or more GitHub repos that end-users are permitted to work on. For each repo, set the guardrail path (which files the agent may edit). End-users see only repos on this list; they never specify a raw URL.
5. **Sign in** — once all steps are green, sign in with GitHub and you are in the panel.

### End-user flow (no CLI or SSH needed)

Once the operator has completed the wizard, end-users interact entirely through the web UI:

1. **Sign in with GitHub** — OAuth login using their own GitHub account.
2. **Pick a repo** — choose from the operator-configured allowlist. Tweaklet clones it using the user's own token; they can only access repos their GitHub account already has access to.
3. **Tweak** — describe the UI change in the panel; the agent proposes and applies edits.
4. **Ship** — submit opens a Pull Request on GitHub authored as that user, with commits carrying their identity.

---

## Changing the base path

The default is `/tweaklet`. To use a different prefix set `server.basePath` in `~/.tweaklet/config.json` and update your reverse-proxy rule to match.
