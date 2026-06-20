# P2 — Live Preview (vite-dev-on-worktree) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On nexus-dev, serve the t8a frontend from the agent's cloned working tree via `vite dev` (HMR) behind Caddy, so an agent edit to `frontend/src/**` appears live in the app the user is viewing — without touching prod.

**Architecture:** Caddy stops sending `/` to the static-image container and instead sends it to a `vite dev` server (`:5173`) running on the clone's `frontend/`, while backend-owned prefixes (`/api`, `/auth`, `/health`) still go to the container (`:8080`). A `t8a-frontend-dev` systemd unit runs that vite server; Tweaklet's `/agent/clone` flow installs deps + (re)starts it. When vite is down (no clone yet) Caddy falls back to the container so the app and wizard stay reachable. Everything lives in the **dev** Terraform module + env-gated vite config, so prod is structurally untouched (prod runs `vite build`, never `vite dev`).

**Tech Stack:** Vite 5 dev server + HMR, Caddy reverse proxy (`lb_policy first` failover), systemd, a narrow sudoers rule, Tweaklet (Node/TS) `/agent/clone`, GCP VM (`t8a-dev-server`, us-east1-c).

**Branch strategy:** This spans t8a infra (`infra/terraform/dev/`) + t8a frontend (`frontend/vite.config.ts`) + Tweaklet, so it is **NOT** tweaklet-trunk-to-main. Use a feature branch + PR: `feature/tweaklet-live-preview` → `main`. File a NEXUS ticket per the repo workflow and name the branch `<type>/NEXUS-NNN-live-preview` if you want Linear auto-linking. Run the full pre-push gate (`make ci-local`).

**DO NOT** touch `infra/terraform/startup.sh` (prod), `deploy.yml`, the `:latest` tag, or `nexus.transcenda.com`. Prod stays static-image + no widget + no vite.

---

## File Structure

- `frontend/vite.config.ts` (t8a) — make the dev-server section **env-gated**: when `VITE_PUBLIC_HOST` is set, allow that host + configure HMR over `wss` for behind-Caddy serving. Local `make dev` (no env) is unchanged. Extract a pure `devServer(env)` helper so it's unit-testable.
- `tweaklet/src/config/config.ts` — add an optional `preview` config block (`serviceName`, `subdir`, `installCheckDir`) so Tweaklet stays host-agnostic (no hardcoded `t8a-frontend-dev`/`frontend`).
- `tweaklet/src/run/preview.ts` (new) — `ensurePreview(repoPath, preview, exec?)`: install deps if missing in `repoPath/<subdir>`, then `sudo systemctl restart <serviceName>`. Injectable `exec` for tests.
- `tweaklet/src/run/preview.test.ts` (new) — unit tests for `ensurePreview`.
- `tweaklet/src/server/server.ts` — in `/agent/clone`, after `config.repo.path` is set, call `ensurePreview` (injectable dep; non-fatal on error).
- `infra/terraform/dev/startup.sh` — Caddy routing split + dev CSP for vite; write the `t8a-frontend-dev` systemd unit + the sudoers rule.
- `infra/terraform/dev/README.md` — document the live-preview architecture + the out-of-band apply for the current VM.

---

### Task 1: Env-gated vite dev-server config (t8a frontend)

**Files:**
- Modify: `frontend/vite.config.ts`
- Test: `frontend/src/__tests__/vite-dev-server.test.ts` (new)

**Context:** Vite 5 rejects requests whose `Host` isn't in `server.allowedHosts`, and its HMR client defaults to `ws://<host>:5173` — wrong behind Caddy TLS. We need those settings **only** when serving publicly (the VM), never for local `make dev`. Gate on `VITE_PUBLIC_HOST`. `vite build` (prod) ignores `server`, so prod is unaffected regardless.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/vite-dev-server.test.ts
import { describe, it, expect } from "vitest";
import { devServer } from "../../vite.config";

describe("devServer", () => {
  it("local dev (no VITE_PUBLIC_HOST): no allowedHosts/hmr override, keeps proxy", () => {
    const s = devServer({});
    expect(s.allowedHosts).toBeUndefined();
    expect(s.hmr).toBeUndefined();
    expect(s.proxy["/api"]).toBe("http://127.0.0.1:8080");
  });
  it("public host set: allows that host + wss HMR on 443, binds loopback", () => {
    const s = devServer({ VITE_PUBLIC_HOST: "nexus-dev.transcenda.com" });
    expect(s.allowedHosts).toEqual(["nexus-dev.transcenda.com"]);
    expect(s.hmr).toEqual({ protocol: "wss", host: "nexus-dev.transcenda.com", clientPort: 443 });
    expect(s.proxy["/api"]).toBe("http://127.0.0.1:8080");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`devServer` not exported)

Run: `cd frontend && npx vitest run src/__tests__/vite-dev-server.test.ts`
Expected: FAIL — `devServer is not a function` / import error.

- [ ] **Step 3: Implement**

```ts
// frontend/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Dev-server config. Pure + exported so it can be unit-tested.
 *  Behind-Caddy public serving is enabled ONLY when VITE_PUBLIC_HOST is set
 *  (the nexus-dev t8a-frontend-dev unit sets it); local `make dev` leaves it
 *  unset and gets the plain loopback dev server. `vite build` ignores all of
 *  this, so prod is unaffected. */
export function devServer(env: Record<string, string | undefined>) {
  const publicHost = env.VITE_PUBLIC_HOST;
  const base = {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
    } as Record<string, string>,
  };
  if (!publicHost) return base;
  return {
    ...base,
    host: "127.0.0.1",
    allowedHosts: [publicHost],
    hmr: { protocol: "wss", host: publicHost, clientPort: 443 },
  };
}

export default defineConfig({
  plugins: [react()],
  server: devServer(process.env),
});
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd frontend && npx vitest run src/__tests__/vite-dev-server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm local dev unaffected + types**

Run: `cd frontend && npx tsc -b --noEmit && npm run build`
Expected: clean (prod build ignores `server`).

- [ ] **Step 6: Commit**

```bash
git add frontend/vite.config.ts frontend/src/__tests__/vite-dev-server.test.ts
git commit -m "feat(frontend): env-gated public-host vite dev server (VITE_PUBLIC_HOST) for nexus-dev live preview"
```

---

### Task 2: Tweaklet `preview` config block

**Files:**
- Modify: `tweaklet/src/config/config.ts`
- Test: existing config test file (add a case) or `tweaklet/src/config/config.test.ts`

**Context:** Keep Tweaklet host-agnostic — the systemd service name + frontend subdir are config, not hardcoded. Optional; absent → preview is a no-op.

- [ ] **Step 1: Write the failing test** (add to the config test file)

```ts
import { ConfigSchema } from "./config.js";
it("accepts an optional preview block", () => {
  const c = ConfigSchema.parse({
    server: { port: 4319, publicUrl: "https://x", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
    guardrails: { allow: ["frontend/src/**"] },
    setup: { completed: false },
    preview: { serviceName: "t8a-frontend-dev", subdir: "frontend", installCheckDir: "frontend/node_modules" },
  });
  expect(c.preview?.serviceName).toBe("t8a-frontend-dev");
});
it("preview is optional", () => {
  const c = ConfigSchema.parse({
    server: { port: 4319, publicUrl: "https://x", sessionSecret: "z".repeat(32), basePath: "/tweaklet" },
    guardrails: { allow: ["frontend/src/**"] },
    setup: { completed: false },
  });
  expect(c.preview).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect FAIL** (`preview` stripped/unknown)

Run: `cd tweaklet && npx vitest run src/config/config.test.ts`
Expected: FAIL — `preview` undefined after parse.

- [ ] **Step 3: Implement** — add to the Zod schema in `config.ts` (place beside `repo`/`agent`):

```ts
  preview: z
    .object({
      serviceName: z.string(),           // systemd unit Tweaklet (re)starts, e.g. "t8a-frontend-dev"
      subdir: z.string(),                // dev-server cwd relative to repo.path, e.g. "frontend"
      installCheckDir: z.string(),       // if missing, run install before starting, e.g. "frontend/node_modules"
    })
    .optional(),
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd tweaklet && npx vitest run src/config/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `cd tweaklet && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tweaklet/src/config/config.ts tweaklet/src/config/config.test.ts
git commit -m "feat(tweaklet): optional preview config (serviceName/subdir/installCheckDir)"
```

---

### Task 3: `ensurePreview` — install deps + (re)start the dev server

**Files:**
- Create: `tweaklet/src/run/preview.ts`
- Test: `tweaklet/src/run/preview.test.ts`

**Context:** After a clone, the clone's `frontend/` has no `node_modules`. Install once, then restart the systemd unit (via the sudoers-allowed `sudo systemctl restart`). Injectable `exec` (mirrors `repo.ts`/`clone.ts` exec patterns) so tests don't shell out.

- [ ] **Step 1: Write the failing test**

```ts
// tweaklet/src/run/preview.test.ts
import { describe, it, expect, vi } from "vitest";
import { ensurePreview } from "./preview.js";

const PREVIEW = { serviceName: "t8a-frontend-dev", subdir: "frontend", installCheckDir: "frontend/node_modules" };

describe("ensurePreview", () => {
  it("no-op when preview is undefined", async () => {
    const exec = vi.fn();
    const r = await ensurePreview("/repo", undefined, { exec, exists: () => true });
    expect(r.started).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
  it("installs deps when installCheckDir missing, then restarts the unit", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const r = await ensurePreview("/repo", PREVIEW, { exec, exists: () => false });
    expect(exec).toHaveBeenCalledWith("npm", ["ci"], expect.objectContaining({ cwd: "/repo/frontend" }));
    expect(exec).toHaveBeenCalledWith("sudo", ["systemctl", "restart", "t8a-frontend-dev"], expect.anything());
    expect(r.started).toBe(true);
  });
  it("skips install when deps present, still restarts", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await ensurePreview("/repo", PREVIEW, { exec, exists: () => true });
    expect(exec).not.toHaveBeenCalledWith("npm", ["ci"], expect.anything());
    expect(exec).toHaveBeenCalledWith("sudo", ["systemctl", "restart", "t8a-frontend-dev"], expect.anything());
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

Run: `cd tweaklet && npx vitest run src/run/preview.test.ts`
Expected: FAIL — cannot find `./preview.js`.

- [ ] **Step 3: Implement**

```ts
// tweaklet/src/run/preview.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
export type Exec = (cmd: string, args: string[], opts: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
export interface PreviewConfig { serviceName: string; subdir: string; installCheckDir: string; }

/**
 * Make the live-preview dev server reflect the current clone: install the
 * dev-server deps if absent, then (re)start its systemd unit. Returns
 * {started:false} when no preview is configured (host-agnostic no-op).
 * Errors propagate to the caller, which treats preview failure as non-fatal.
 */
export async function ensurePreview(
  repoPath: string,
  preview: PreviewConfig | undefined,
  deps: { exec?: Exec; exists?: (p: string) => boolean } = {},
): Promise<{ started: boolean }> {
  if (!preview) return { started: false };
  const exec = deps.exec ?? ((c, a, o) => pexec(c, a, o));
  const exists = deps.exists ?? existsSync;
  const cwd = join(repoPath, preview.subdir);
  if (!exists(join(repoPath, preview.installCheckDir))) {
    await exec("npm", ["ci"], { cwd });
  }
  // Sudoers grants the Tweaklet user exactly this restart (see startup.sh).
  await exec("sudo", ["systemctl", "restart", preview.serviceName], { cwd });
  return { started: true };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd tweaklet && npx vitest run src/run/preview.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tweaklet/src/run/preview.ts tweaklet/src/run/preview.test.ts
git commit -m "feat(tweaklet): ensurePreview — install deps + (re)start the live-preview dev server"
```

---

### Task 4: Trigger preview from `/agent/clone`

**Files:**
- Modify: `tweaklet/src/server/server.ts` (the `/agent/clone` handler + the deps wiring)
- Test: `tweaklet/src/server/agent-routes.test.ts` (or wherever clone is tested)

**Context:** After the clone sets `config.repo.path`, kick the preview. **Non-fatal**: a preview failure must not fail the clone (the wizard/agent still work; preview is an enhancement). Injectable like the other server deps.

- [ ] **Step 1: Write the failing test** — clone triggers `ensurePreview` when `preview` is configured:

```ts
it("POST /agent/clone triggers ensurePreview when preview is configured", async () => {
  const ensurePreview = vi.fn(async () => ({ started: true }));
  // build server with preview config + signed-in session (reuse the file's signIn helper),
  // inject { cloneRepo: async () => "/repo", ensurePreview }
  // ... drive /agent/clone ...
  expect(ensurePreview).toHaveBeenCalledWith("/repo", expect.objectContaining({ serviceName: "t8a-frontend-dev" }), expect.anything());
});
it("clone still succeeds (200) when ensurePreview throws", async () => {
  const ensurePreview = vi.fn(async () => { throw new Error("systemctl failed"); });
  // inject; drive /agent/clone; expect 200 + { path }
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd tweaklet && npx vitest run src/server/agent-routes.test.ts`
Expected: FAIL (`ensurePreview` not called / not injectable).

- [ ] **Step 3: Implement** — wire the dep + call it. In `ServerDeps` add:

```ts
  ensurePreview?: typeof import("../run/preview.js").ensurePreview;
```

Near the other `deps.x ?? real` bindings:

```ts
import { ensurePreview as realEnsurePreview } from "../run/preview.js";
// ...
const doEnsurePreview = deps.ensurePreview ?? realEnsurePreview;
```

In the `/agent/clone` handler, after `config.repo = { ...config.repo, path }; doSaveConfig(config);` and before `res.json({ path })`:

```ts
    // Live preview (P2): reflect the new clone in the dev server. Non-fatal —
    // the agent works without it; it's an enhancement.
    try { await doEnsurePreview(path, config.preview); }
    catch (e) { console.warn("Tweaklet: live-preview (re)start failed:", String(e)); }
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd tweaklet && npx vitest run src/server/agent-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full tweaklet gate**

Run: `cd tweaklet && npm run build && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tweaklet/src/server/server.ts tweaklet/src/server/agent-routes.test.ts
git commit -m "feat(tweaklet): /agent/clone (re)starts the live-preview dev server (non-fatal)"
```

---

### Task 5: Dev infra — Caddy routing + dev CSP for vite (startup.sh)

**Files:**
- Modify: `infra/terraform/dev/startup.sh` (the `$DOMAIN` Caddyfile block, lines ~184–208)

**Context:** Split backend prefixes to `:8080`; send everything else to `:5173` with **failover to `:8080`** (`lb_policy first`) so the app + wizard stay up before any clone/preview. Add `'unsafe-eval'` to `script-src` (vite dev) — DEV ONLY (this Caddyfile is dev). HMR `wss` to same origin is already covered by `connect-src 'self'`.

- [ ] **Step 1: Replace the `handle`/`handle /tweaklet/*` block** inside `$DOMAIN { ... }` with:

```caddyfile
    # Tweaklet (DEV-ONLY): AI tweak panel under /tweaklet/* → :4319.
    handle /tweaklet/* {
        reverse_proxy localhost:4319
    }
    # Backend-owned prefixes always go to the t8a container (:8080).
    handle /api/* {
        reverse_proxy localhost:8080
    }
    handle /auth/* {
        reverse_proxy localhost:8080
    }
    handle /health* {
        reverse_proxy localhost:8080
    }
    # Everything else = the SPA. Prefer the live vite dev server (:5173, served
    # from the agent's clone); fail over to the static-image container (:8080)
    # whenever vite is down (no clone yet, or it crashed). `lb_policy first` +
    # `fail_duration` give ordered failover with passive health checks.
    handle {
        reverse_proxy localhost:5173 localhost:8080 {
            lb_policy first
            fail_duration 5s
        }
    }
```

- [ ] **Step 2: Update the CSP `script-src`** in the same Caddyfile `header` block — add `'unsafe-eval'` (vite dev transforms):

Change:
```
script-src 'self' 'unsafe-inline' accounts.google.com;
```
to:
```
script-src 'self' 'unsafe-inline' 'unsafe-eval' accounts.google.com;
```

- [ ] **Step 3: Sanity-check the template still renders** (terraform validate, no apply):

Run: `cd infra/terraform/dev && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/dev/startup.sh
git commit -m "feat(infra/dev): Caddy routes / → vite dev (:5173) with :8080 failover; backend prefixes split; dev CSP allows unsafe-eval for vite"
```

> **Verification of behaviour happens on the VM in Task 7** (Caddy failover is empirical). Expected once applied: `curl https://nexus-dev.transcenda.com/` returns the static SPA when vite is down, and the vite-served SPA (with `@vite/client`) when it's up.

---

### Task 6: Dev infra — `t8a-frontend-dev` systemd unit + sudoers (startup.sh)

**Files:**
- Modify: `infra/terraform/dev/startup.sh` (add a block before the final `echo "=== T8A dev is running ==="`)

**Context:** The unit runs `vite dev` on the clone's `frontend/` as the clone owner, with `VITE_PUBLIC_HOST` set so Task 1's config kicks in. It is **not** auto-started at boot (the clone may not exist yet); Tweaklet starts it post-clone (Task 4) via a narrow sudoers grant.

- [ ] **Step 1: Add the unit + sudoers writer** to `startup.sh`:

```bash
# ─── Live preview (DEV-ONLY): t8a frontend vite dev on the agent's clone ──────
# Serves the SPA from the active clone with HMR so agent edits to frontend/src
# appear live. Tweaklet (re)starts it after /agent/clone; not auto-started at
# boot because the clone may not exist yet. NOT present in prod.
CLONE_OWNER="jchereshnovsky_transcenda_com"
CLONE_FRONTEND="/home/$CLONE_OWNER/tweaklet-repos/t8a/frontend"
cat > /etc/systemd/system/t8a-frontend-dev.service <<UNIT
[Unit]
Description=t8a frontend vite dev (live preview on the agent's clone)
After=network.target

[Service]
Type=simple
User=$CLONE_OWNER
WorkingDirectory=$CLONE_FRONTEND
Environment=VITE_PUBLIC_HOST=${domain}
ExecStart=/usr/bin/npm run dev -- --port 5173 --host 127.0.0.1
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

# Narrow sudoers: the Tweaklet user may manage ONLY this unit, no password.
cat > /etc/sudoers.d/tweaklet-preview <<SUDOERS
$CLONE_OWNER ALL=(root) NOPASSWD: /usr/bin/systemctl restart t8a-frontend-dev, /usr/bin/systemctl start t8a-frontend-dev, /usr/bin/systemctl stop t8a-frontend-dev, /usr/bin/systemctl status t8a-frontend-dev
SUDOERS
chmod 440 /etc/sudoers.d/tweaklet-preview
visudo -cf /etc/sudoers.d/tweaklet-preview   # validate; non-zero aborts boot (set -e)

systemctl daemon-reload
```

> Note: `${domain}` is the existing template var (e.g. `nexus-dev.transcenda.com`). `npm` is already on the VM (Tweaklet runs on Node); `vite` comes from the clone's `frontend/node_modules` (installed by `ensurePreview`).

- [ ] **Step 2: Add `preview` to the Tweaklet config the VM uses.** The VM's `~/.tweaklet/config.json` must carry the `preview` block so `/agent/clone` triggers the unit. Document this in the README (Task 8) and set it during the out-of-band deploy (Task 7). The value:

```json
"preview": { "serviceName": "t8a-frontend-dev", "subdir": "frontend", "installCheckDir": "frontend/node_modules" }
```

- [ ] **Step 3: terraform validate**

Run: `cd infra/terraform/dev && terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/dev/startup.sh
git commit -m "feat(infra/dev): t8a-frontend-dev systemd unit + narrow sudoers for Tweaklet to (re)start it"
```

---

### Task 7: Apply to the current VM + end-to-end verification

**Context:** `startup.sh` only runs on VM reset, so apply the unit/sudoers/Caddy out-of-band to the running VM (faster than a reset and keeps Postgres data), redeploy the Tweaklet code (out-of-band, per the dev README), set the `preview` config, then prove the loop. SSH: `gcloud compute ssh t8a-dev-server --zone=us-east1-c --tunnel-through-iap`.

- [ ] **Step 1: Install the systemd unit + sudoers on the VM** (paste the rendered unit + sudoers from Task 6, substituting `${domain}`=`nexus-dev.transcenda.com`), then `sudo systemctl daemon-reload` and `sudo visudo -cf /etc/sudoers.d/tweaklet-preview` (expect "parsed OK").

- [ ] **Step 2: Update Caddy on the VM** — apply the Task 5 Caddyfile block to `/etc/caddy/Caddyfile`, `sudo systemctl reload caddy`, confirm `systemctl is-active caddy` = active.

- [ ] **Step 3: Redeploy Tweaklet code** (the Task 2–4 changes) out-of-band per `infra/terraform/dev/README.md` (tar `tweaklet/` → scp → `npm run build` → `sudo systemctl restart tweaklet`). Set the preview config:

```bash
node -e "const fs=require('fs'),p=process.env.HOME+'/.tweaklet/config.json',c=JSON.parse(fs.readFileSync(p));c.preview={serviceName:'t8a-frontend-dev',subdir:'frontend',installCheckDir:'frontend/node_modules'};fs.writeFileSync(p,JSON.stringify(c,null,2))"
```

- [ ] **Step 4: Trigger a clone (re)install + preview start.** Easiest: re-run the clone via the panel, or directly `sudo systemctl start t8a-frontend-dev` after a manual `cd ~/tweaklet-repos/t8a/frontend && npm ci`. Verify vite is listening:

Run (on VM): `sudo ss -ltnp | grep 5173 && curl -s http://127.0.0.1:5173/ | grep -c "@vite/client"`
Expected: a LISTEN on 127.0.0.1:5173 and `1` (the dev HTML injects the vite client).

- [ ] **Step 5: Caddy failover both ways.**
  - vite UP: `curl -s https://nexus-dev.transcenda.com/ | grep -c "@vite/client"` → `1` (served by vite).
  - vite DOWN: `sudo systemctl stop t8a-frontend-dev`, then the same curl → `0` and HTTP 200 (static image served via failover). Restart it after.

- [ ] **Step 6: HMR end-to-end (the actual goal).** In a browser logged into nexus-dev, open `/` (DevTools → Network shows the `@vite/client` wss connected). Run a tweak through the panel ("add Hello World next to NEXUS") OR edit `~/tweaklet-repos/t8a/frontend/src/shared/components/TranscendaNexusBrand.tsx` on the VM. Expected: the header updates **without a full reload** (HMR). Then `git -C ~/tweaklet-repos/t8a checkout -- .` to reset.

- [ ] **Step 7: Backend paths still work** — sign-in (OIDC `/auth/google/*`) and `/api/*` calls succeed (they go to `:8080`, not vite). Confirm you can log into the t8a app and load `/my-work`.

> No commit — this task is verification + out-of-band ops. Capture results in the PR description.

---

### Task 8: Docs — README + architecture

**Files:**
- Modify: `infra/terraform/dev/README.md`

- [ ] **Step 1:** Add a "Live preview (P2)" section documenting: the Caddy routing (`/`→vite `:5173` with `:8080` failover; `/api`,`/auth`,`/health`→`:8080`), the `t8a-frontend-dev` unit + sudoers, the `preview` config in `~/.tweaklet/config.json`, the `VITE_PUBLIC_HOST` env, and that it's **dev-only / prod untouched**. Include the out-of-band apply steps (Task 7) since `startup.sh` only runs on reset.

- [ ] **Step 2: Commit**

```bash
git add infra/terraform/dev/README.md
git commit -m "docs(infra/dev): document the live-preview architecture + out-of-band apply"
```

---

### Task 9: PR + full gate

- [ ] **Step 1:** Push the branch and open a PR to `main` (title: `feat(tweaklet): P2 live preview — vite-dev-on-worktree on nexus-dev`). Body: what changed, the Task 7 verification results, and the explicit prod-untouched statement.
- [ ] **Step 2:** Ensure the pre-push gate ran (`make ci-local`) — the t8a frontend test (Task 1) + tweaklet suite must pass. The cloud PR runs static analysis only.

---

## Self-Review

**Spec coverage (P2 section of the spec):**
- "serve the t8a frontend via `vite dev` on the clone behind Caddy" → Tasks 5, 6, 7. ✓
- "Caddy `/`→:5173, `/api`→:8080, `/tweaklet`→:4319" → Task 5 (+ `/auth`,`/health` split, + failover, which the spec implies via "app stays reachable"). ✓
- "`t8a-frontend-dev` systemd unit, started when a repo is cloned" → Task 6 (unit) + Task 4 (`/agent/clone` trigger) + Task 3 (`ensurePreview`). ✓
- "install the t8a frontend node_modules on the clone" → Task 3 (`npm ci` when `installCheckDir` missing). ✓
- "vite.config dev-server settings (allowedHosts, HMR wss, proxy)" → Task 1. ✓
- "per-env: on dev, off prod" → dev module only + `VITE_PUBLIC_HOST` gate + prod runs `vite build` (Task 1 note). ✓
- Verified facts honored: no machine bump (Task notes), opencode persistence untouched (P2.6, out of scope). ✓

**Placeholder scan:** No TBD/TODO; every code/infra step has concrete content; Caddy failover behaviour is explicitly empirical and verified in Task 7 (not a placeholder — the directive is given, the VM test confirms it). The Task 4 test bodies reference "reuse the file's signIn helper" — the helper exists (`signInAlice`-style in the tweaklet route tests); the implementer fills the standard sign-in dance shown there.

**Type/name consistency:** `preview` shape (`serviceName`/`subdir`/`installCheckDir`) is identical across Task 2 (schema), Task 3 (`PreviewConfig`), Task 4 (call), Task 6 (values), Task 7 (config). `devServer(env)` signature consistent (Task 1). `ensurePreview(repoPath, preview, deps)` consistent (Tasks 3, 4). `VITE_PUBLIC_HOST` consistent (Tasks 1, 6).

**Open items deferred to planning-time discovery (not blockers):** exact Caddy `lb_policy first` + `fail_duration` failover behaviour is confirmed empirically in Task 7 (if it misbehaves, fall back to `/`→:5173 only and accept the app is down pre-clone — documented in the README); whether the t8a backend owns top-level prefixes beyond `/api`,`/auth`,`/health` (if so, add a `handle` in Task 5 — grep the Axum router during implementation).
