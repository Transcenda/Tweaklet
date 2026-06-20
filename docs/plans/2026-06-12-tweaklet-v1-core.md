# tweaklet v1 — Plan 1: Core (config + init wizard + GitHub OAuth + authed server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the tweaklet service skeleton: a developer can configure it (`tweaklet init`), run it (`tweaklet serve`), and a user can sign in with the company's GitHub OAuth App and reach an authenticated page.

**Architecture:** A small Node/TypeScript (ESM) service. A home-dir JSON config (`~/.tweaklet/config.json`, validated with Zod) holds the per-company GitHub OAuth client + server settings. An Express server gates all app routes behind a GitHub OAuth login; the session is a stateless signed cookie (HMAC, `node:crypto`) — no database. OAuth state is also a signed cookie, so the server is stateless. Everything is dependency-injected (fetch, oauth helpers) so it unit-tests without network.

**Tech Stack:** Node 20+ (native `fetch`), TypeScript (ESM), Express 4, Zod, Vitest + Supertest. Package manager: npm.

> **Spec:** [`../specs/2026-06-11-universal-ai-sandbox-design.md`](../specs/2026-06-11-universal-ai-sandbox-design.md) §6.1 (wizard steps 1–3), §6.5 (per-company OAuth, app-level auth). Later plans cover §6.2 (agent), §6.3 (panel + lifecycle), §6.4 (live-update).
>
> **Location:** new package at `tweaklet/` (repo root, on branch `spike/ai-sandbox`). Relocatable to its own repo later (Open Decision in the spec). **No git worktree** — work in the main checkout per project convention.
>
> **Roadmap:** Plans 2–4 (agent loop, lifecycle, T8A integration) get their own plan docs after this one executes.

---

### Task 1: Scaffold the `tweaklet` package

**Files:**
- Create: `tweaklet/package.json`
- Create: `tweaklet/tsconfig.json`
- Create: `tweaklet/vitest.config.ts`
- Create: `tweaklet/src/smoke.test.ts`

- [ ] **Step 1: Create `tweaklet/package.json`**

```json
{
  "name": "tweaklet",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "tweaklet": "./dist/index.js" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "express": "^4.19.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tweaklet/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `tweaklet/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `tweaklet/src/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Install and run the smoke test**

Run: `cd tweaklet && npm install && npm test`
Expected: PASS (1 test passed).

- [ ] **Step 6: Commit**

```bash
git add tweaklet/package.json tweaklet/tsconfig.json tweaklet/vitest.config.ts tweaklet/src/smoke.test.ts tweaklet/package-lock.json
git commit -m "chore(tweaklet): scaffold Node/TS package + test toolchain"
```

---

### Task 2: Config module (home-dir JSON, Zod-validated)

**Files:**
- Create: `tweaklet/src/config/config.ts`
- Test: `tweaklet/src/config/config.test.ts`

> Config dir resolves from `TWEAKLET_HOME` if set, else `os.homedir()`. The env override makes it unit-testable without touching the real home dir.

- [ ] **Step 1: Write the failing test**

```ts
// tweaklet/src/config/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, configExists, type TweakletConfig } from "./config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tweaklet-"));
  process.env.TWEAKLET_HOME = home;
});
afterEach(() => {
  delete process.env.TWEAKLET_HOME;
  rmSync(home, { recursive: true, force: true });
});

const valid: TweakletConfig = {
  github: {
    clientId: "cid",
    clientSecret: "secret",
    oauthBaseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
  },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "x".repeat(32) },
};

describe("config", () => {
  it("round-trips save → load", () => {
    expect(configExists()).toBe(false);
    saveConfig(valid);
    expect(configExists()).toBe(true);
    expect(loadConfig()).toEqual(valid);
  });

  it("throws a clear error when missing", () => {
    expect(() => loadConfig()).toThrow(/no tweaklet config/i);
  });

  it("rejects an invalid config", () => {
    saveConfig(valid);
    // corrupt it
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(home, ".tweaklet", "config.json"), JSON.stringify({ github: {} }));
    expect(() => loadConfig()).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tweaklet && npx vitest run src/config/config.test.ts`
Expected: FAIL (cannot find module `./config.js`).

- [ ] **Step 3: Write `tweaklet/src/config/config.ts`**

```ts
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const ConfigSchema = z.object({
  github: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    oauthBaseUrl: z.string().url().default("https://github.com"),
    apiBaseUrl: z.string().url().default("https://api.github.com"),
  }),
  server: z.object({
    port: z.number().int().positive(),
    publicUrl: z.string().url(),
    sessionSecret: z.string().min(16),
  }),
});

export type TweakletConfig = z.infer<typeof ConfigSchema>;

function configDir(): string {
  return join(process.env.TWEAKLET_HOME ?? homedir(), ".tweaklet");
}
export function configPath(): string {
  return join(configDir(), "config.json");
}
export function configExists(): boolean {
  return existsSync(configPath());
}
export function saveConfig(cfg: TweakletConfig): void {
  const parsed = ConfigSchema.parse(cfg);
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(parsed, null, 2));
}
export function loadConfig(): TweakletConfig {
  if (!configExists()) {
    throw new Error(`No tweaklet config at ${configPath()}. Run \`tweaklet init\` first.`);
  }
  return ConfigSchema.parse(JSON.parse(readFileSync(configPath(), "utf8")));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tweaklet && npx vitest run src/config/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tweaklet/src/config/
git commit -m "feat(tweaklet): home-dir config with Zod validation"
```

---

### Task 3: GitHub OAuth helpers

**Files:**
- Create: `tweaklet/src/auth/github-oauth.ts`
- Test: `tweaklet/src/auth/github-oauth.test.ts`

> Pure functions, `fetch` injected, so no network in tests. Implements the device-less web flow: authorize URL → exchange code for token → fetch the user login.

- [ ] **Step 1: Write the failing test**

```ts
// tweaklet/src/auth/github-oauth.test.ts
import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchGithubUser } from "./github-oauth.js";

describe("github-oauth", () => {
  it("builds an authorize URL with the right params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: "http://localhost:4319/auth/callback",
        state: "st8",
        oauthBaseUrl: "https://github.com",
      }),
    );
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4319/auth/callback");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("scope")).toBe("repo");
  });

  it("exchanges a code for an access token", async () => {
    const fakeFetch = async (input: string, init?: any) => {
      expect(input).toBe("https://github.com/login/oauth/access_token");
      expect(init.headers.Accept).toBe("application/json");
      return { ok: true, json: async () => ({ access_token: "gho_tok" }) } as any;
    };
    const tok = await exchangeCodeForToken(
      { code: "c", clientId: "cid", clientSecret: "sec", redirectUri: "http://x/cb", oauthBaseUrl: "https://github.com" },
      fakeFetch as any,
    );
    expect(tok).toBe("gho_tok");
  });

  it("fetches the github user login", async () => {
    const fakeFetch = async (input: string, init?: any) => {
      expect(input).toBe("https://api.github.com/user");
      expect(init.headers.Authorization).toBe("Bearer gho_tok");
      return { ok: true, json: async () => ({ login: "alice", id: 7 }) } as any;
    };
    const user = await fetchGithubUser(
      { token: "gho_tok", apiBaseUrl: "https://api.github.com" },
      fakeFetch as any,
    );
    expect(user).toEqual({ login: "alice", id: 7 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tweaklet && npx vitest run src/auth/github-oauth.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `tweaklet/src/auth/github-oauth.ts`**

```ts
type FetchLike = typeof fetch;

export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  oauthBaseUrl: string;
}): string {
  const u = new URL("/login/oauth/authorize", args.oauthBaseUrl);
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("state", args.state);
  u.searchParams.set("scope", "repo");
  return u.toString();
}

export async function exchangeCodeForToken(
  args: { code: string; clientId: string; clientSecret: string; redirectUri: string; oauthBaseUrl: string },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const res = await fetchImpl(`${args.oauthBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`token exchange returned no token: ${body.error ?? "unknown"}`);
  return body.access_token;
}

export interface GithubUser {
  login: string;
  id: number;
}

export async function fetchGithubUser(
  args: { token: string; apiBaseUrl: string },
  fetchImpl: FetchLike = fetch,
): Promise<GithubUser> {
  const res = await fetchImpl(`${args.apiBaseUrl}/user`, {
    headers: { Authorization: `Bearer ${args.token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`fetch user failed: ${res.status}`);
  const body = (await res.json()) as GithubUser;
  return { login: body.login, id: body.id };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tweaklet && npx vitest run src/auth/github-oauth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tweaklet/src/auth/github-oauth.ts tweaklet/src/auth/github-oauth.test.ts
git commit -m "feat(tweaklet): github OAuth helpers (authorize url, token exchange, user)"
```

---

### Task 4: Signed-cookie session + state

**Files:**
- Create: `tweaklet/src/auth/signing.ts`
- Test: `tweaklet/src/auth/signing.test.ts`

> One small primitive used for both the login session and the OAuth `state` (so the server stays stateless). `sign` returns `base64url(json).hmac`; `verify` returns the payload or `null` on tamper/wrong-secret.

- [ ] **Step 1: Write the failing test**

```ts
// tweaklet/src/auth/signing.test.ts
import { describe, it, expect } from "vitest";
import { sign, verify } from "./signing.js";

const secret = "s".repeat(32);

describe("signing", () => {
  it("round-trips a payload", () => {
    const t = sign({ login: "alice", id: 7 }, secret);
    expect(verify<{ login: string; id: number }>(t, secret)).toEqual({ login: "alice", id: 7 });
  });
  it("returns null on tampering", () => {
    const t = sign({ login: "alice" }, secret);
    expect(verify(t + "x", secret)).toBeNull();
  });
  it("returns null on the wrong secret", () => {
    const t = sign({ login: "alice" }, secret);
    expect(verify(t, "other".repeat(8))).toBeNull();
  });
  it("returns null on malformed input", () => {
    expect(verify("not-a-token", secret)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tweaklet && npx vitest run src/auth/signing.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `tweaklet/src/auth/signing.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function sign(payload: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body, secret)}`;
}

export function verify<T>(token: string, secret: string): T | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = hmac(body, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tweaklet && npx vitest run src/auth/signing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tweaklet/src/auth/signing.ts tweaklet/src/auth/signing.test.ts
git commit -m "feat(tweaklet): HMAC signed-token primitive for session + oauth state"
```

---

### Task 5: Express server with the GitHub auth gate

**Files:**
- Create: `tweaklet/src/server/server.ts`
- Test: `tweaklet/src/server/server.test.ts`

> `createServer(config, deps)` returns an Express app. `deps` injects the oauth functions so the callback is testable offline. Cookies: `apz_session` (login) and `apz_oauth_state` (CSRF state), both signed with `config.server.sessionSecret`. Routes: `GET /auth/login`, `GET /auth/callback`, `GET /api/me` (protected), `POST /auth/logout`, `GET /` (authed placeholder).

- [ ] **Step 1: Write the failing test**

```ts
// tweaklet/src/server/server.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";

const config: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
};

function appWith(overrides = {}) {
  return createServer(config, {
    exchangeCodeForToken: async () => "gho_tok",
    fetchGithubUser: async () => ({ login: "alice", id: 7 }),
    ...overrides,
  });
}

describe("server", () => {
  it("401s /api/me without a session", async () => {
    await request(appWith()).get("/api/me").expect(401);
  });

  it("returns the user on /api/me with a valid session cookie", async () => {
    const cookie = `apz_session=${sign({ login: "alice", id: 7 }, config.server.sessionSecret)}`;
    const res = await request(appWith()).get("/api/me").set("Cookie", cookie).expect(200);
    expect(res.body).toEqual({ login: "alice", id: 7 });
  });

  it("/auth/login redirects to GitHub with a state cookie", async () => {
    const res = await request(appWith()).get("/auth/login").expect(302);
    expect(res.headers.location).toContain("https://github.com/login/oauth/authorize");
    expect(res.headers["set-cookie"].join(";")).toContain("apz_oauth_state=");
  });

  it("/auth/callback exchanges code, sets session, redirects home", async () => {
    const agent = request.agent(appWith());
    const login = await agent.get("/auth/login").expect(302);
    const state = new URL(login.headers.location).searchParams.get("state")!;
    const res = await agent.get(`/auth/callback?code=abc&state=${state}`).expect(302);
    expect(res.headers.location).toBe("/");
    expect(res.headers["set-cookie"].join(";")).toContain("apz_session=");
  });

  it("/auth/callback rejects a mismatched state", async () => {
    await request(appWith()).get("/auth/callback?code=abc&state=forged").expect(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tweaklet && npx vitest run src/server/server.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `tweaklet/src/server/server.ts`**

```ts
import express, { type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import type { TweakletConfig } from "../config/config.js";
import { buildAuthorizeUrl, exchangeCodeForToken as realExchange, fetchGithubUser as realFetchUser, type GithubUser } from "../auth/github-oauth.js";
import { sign, verify } from "../auth/signing.js";

export interface ServerDeps {
  exchangeCodeForToken?: typeof realExchange;
  fetchGithubUser?: typeof realFetchUser;
}

const SESSION_COOKIE = "apz_session";
const STATE_COOKIE = "apz_oauth_state";

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createServer(config: TweakletConfig, deps: ServerDeps = {}) {
  const exchange = deps.exchangeCodeForToken ?? realExchange;
  const fetchUser = deps.fetchGithubUser ?? realFetchUser;
  const secret = config.server.sessionSecret;
  const redirectUri = `${config.server.publicUrl}/auth/callback`;
  const app = express();

  function currentUser(req: Request): GithubUser | null {
    const tok = parseCookies(req)[SESSION_COOKIE];
    return tok ? verify<GithubUser>(tok, secret) : null;
  }
  function authGate(req: Request, res: Response, next: NextFunction) {
    if (currentUser(req)) return next();
    res.status(401).json({ error: "unauthorized" });
  }

  app.get("/auth/login", (_req, res) => {
    const state = randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, sign({ state }, secret), { httpOnly: true, sameSite: "lax", path: "/" });
    res.redirect(buildAuthorizeUrl({ clientId: config.github.clientId, redirectUri, state, oauthBaseUrl: config.github.oauthBaseUrl }));
  });

  app.get("/auth/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const signed = parseCookies(req)[STATE_COOKIE];
    const expected = signed ? verify<{ state: string }>(signed, secret) : null;
    if (!code || !expected || expected.state !== state) {
      res.status(400).json({ error: "invalid oauth state" });
      return;
    }
    try {
      const token = await exchange({ code, clientId: config.github.clientId, clientSecret: config.github.clientSecret, redirectUri, oauthBaseUrl: config.github.oauthBaseUrl });
      const user = await fetchUser({ token, apiBaseUrl: config.github.apiBaseUrl });
      res.cookie(SESSION_COOKIE, sign(user, secret), { httpOnly: true, sameSite: "lax", path: "/" });
      res.clearCookie(STATE_COOKIE, { path: "/" });
      res.redirect("/");
    } catch (e) {
      res.status(502).json({ error: "oauth failed", detail: String(e) });
    }
  });

  app.post("/auth/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  app.get("/api/me", authGate, (req, res) => {
    res.json(currentUser(req));
  });

  app.get("/", (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect("/auth/login");
    res.type("html").send(`<!doctype html><meta charset=utf8><h1>tweaklet</h1><p>Signed in as <b>${user.login}</b>.</p>`);
  });

  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tweaklet && npx vitest run src/server/server.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tweaklet/src/server/
git commit -m "feat(tweaklet): express server with GitHub OAuth login gate (stateless cookies)"
```

---

### Task 6: `tweaklet init` — write the config

**Files:**
- Create: `tweaklet/src/wizard/init.ts`
- Test: `tweaklet/src/wizard/init.test.ts`

> v1 `init` takes flags (interactive prompts are a later refinement). It generates the `sessionSecret`, applies GitHub URL defaults, validates, and writes the config. The OAuth-App-creation *guidance* (the human GitHub steps) is printed by the CLI in Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// tweaklet/src/wizard/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./init.js";
import { loadConfig } from "../config/config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tweaklet-"));
  process.env.TWEAKLET_HOME = home;
});
afterEach(() => {
  delete process.env.TWEAKLET_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("runInit", () => {
  it("writes a valid, loadable config and generates a session secret", () => {
    runInit({ githubClientId: "cid", githubClientSecret: "sec", publicUrl: "http://localhost:4319", port: 4319 });
    const cfg = loadConfig();
    expect(cfg.github.clientId).toBe("cid");
    expect(cfg.github.oauthBaseUrl).toBe("https://github.com");
    expect(cfg.server.publicUrl).toBe("http://localhost:4319");
    expect(cfg.server.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts a GitHub Enterprise Server base URL", () => {
    runInit({ githubClientId: "cid", githubClientSecret: "sec", publicUrl: "http://x:4319", port: 4319, githubOauthBaseUrl: "https://ghe.acme.com", githubApiBaseUrl: "https://ghe.acme.com/api/v3" });
    expect(loadConfig().github.apiBaseUrl).toBe("https://ghe.acme.com/api/v3");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tweaklet && npx vitest run src/wizard/init.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Write `tweaklet/src/wizard/init.ts`**

```ts
import { randomBytes } from "node:crypto";
import { saveConfig, configPath, type TweakletConfig } from "../config/config.js";

export interface InitOptions {
  githubClientId: string;
  githubClientSecret: string;
  publicUrl: string;
  port: number;
  githubOauthBaseUrl?: string;
  githubApiBaseUrl?: string;
}

export function runInit(opts: InitOptions): string {
  const cfg: TweakletConfig = {
    github: {
      clientId: opts.githubClientId,
      clientSecret: opts.githubClientSecret,
      oauthBaseUrl: opts.githubOauthBaseUrl ?? "https://github.com",
      apiBaseUrl: opts.githubApiBaseUrl ?? "https://api.github.com",
    },
    server: {
      port: opts.port,
      publicUrl: opts.publicUrl,
      sessionSecret: randomBytes(32).toString("hex"),
    },
  };
  saveConfig(cfg);
  return configPath();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tweaklet && npx vitest run src/wizard/init.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tweaklet/src/wizard/
git commit -m "feat(tweaklet): tweaklet init writes the home-dir config"
```

---

### Task 7: CLI entrypoint (`tweaklet init` / `tweaklet serve`) + manual smoke test

**Files:**
- Create: `tweaklet/src/index.ts`

> Minimal argv routing (no arg-parser dependency). Prints the per-company OAuth-App setup guidance when `init` is missing flags (§6.1 step 2 / §6.5).

- [ ] **Step 1: Write `tweaklet/src/index.ts`**

```ts
#!/usr/bin/env node
import { runInit, type InitOptions } from "./wizard/init.js";
import { loadConfig } from "./config/config.js";
import { createServer } from "./server/server.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printOAuthGuidance(publicUrl: string): void {
  const cb = `${publicUrl}/auth/callback`;
  console.error(
    [
      "Missing GitHub OAuth credentials.",
      "",
      "Register a per-company OAuth App on YOUR GitHub (github.com org or GitHub Enterprise Server):",
      "  Settings → Developer settings → OAuth Apps → New OAuth App",
      `  Authorization callback URL:  ${cb}`,
      "Then re-run:",
      `  tweaklet init --github-client-id <id> --github-client-secret <secret> --public-url ${publicUrl}`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "init") {
    const publicUrl = flag("public-url") ?? "http://localhost:4319";
    const id = flag("github-client-id");
    const secret = flag("github-client-secret");
    if (!id || !secret) {
      printOAuthGuidance(publicUrl);
      process.exit(1);
    }
    const opts: InitOptions = {
      githubClientId: id,
      githubClientSecret: secret,
      publicUrl,
      port: Number(flag("port") ?? new URL(publicUrl).port ?? "4319"),
      githubOauthBaseUrl: flag("github-oauth-base-url"),
      githubApiBaseUrl: flag("github-api-base-url"),
    };
    const path = runInit(opts);
    console.log(`Wrote config to ${path}`);
    return;
  }
  if (cmd === "serve") {
    const config = loadConfig();
    createServer(config).listen(config.server.port, () => {
      console.log(`tweaklet listening on ${config.server.publicUrl}`);
    });
    return;
  }
  console.error("Usage: tweaklet <init|serve> [flags]");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify the full test suite still passes**

Run: `cd tweaklet && npm run build && npm test`
Expected: build succeeds; all tests PASS.

- [ ] **Step 3: Manual smoke test (one-time, requires a real GitHub OAuth App)**

1. On GitHub (org or GHES): *Settings → Developer settings → OAuth Apps → New OAuth App*. Set the callback URL to `http://localhost:4319/auth/callback`. Copy the Client ID + a generated Client Secret.
2. Run: `cd tweaklet && npx tsx src/index.ts init --github-client-id <id> --github-client-secret <secret> --public-url http://localhost:4319`
   Expected: `Wrote config to ~/.tweaklet/config.json`.
3. Run: `npx tsx src/index.ts serve` → open `http://localhost:4319` → you're redirected to GitHub → authorize → land back on a page reading **"Signed in as &lt;your-login&gt;"**.
4. Confirm the gate: in a private window, `curl -i http://localhost:4319/api/me` → `401`.

- [ ] **Step 4: Commit**

```bash
git add tweaklet/src/index.ts
git commit -m "feat(tweaklet): tweaklet CLI (init/serve) + OAuth setup guidance"
```

---

## Self-Review

**Spec coverage (Plan 1 scope = §6.1 steps 1–3, §6.5):**
- §6.1 step 2 (per-company OAuth App, guided) → Task 7 `printOAuthGuidance` + Task 5 login flow. ✓
- §6.1 step 3 (authorize, `repo` scope) → Task 3 `buildAuthorizeUrl` (scope=`repo`) + Task 5 callback. ✓
- §6.5 (GitHub OAuth is the only login; app-level auth; authz = repo access via token) → Task 5 `authGate`; the `repo`-scoped token (used for repo ops in Plan 3) is obtained here. ✓
- §6.1 "config file in the agent user's home dir, no DB" → Task 2 (`~/.tweaklet/config.json`), Task 6 (`init` writes it). ✓
- **Deferred to later plans (correctly out of scope here):** clone/branch/run/live-update config fields (Plan 3 extends `ConfigSchema`), agent driver (Plan 2), panel + lifecycle (Plan 3), T8A snippet (Plan 4). Noted in the header.

**Placeholder scan:** none — every step has complete, runnable code or an exact command. ✓

**Type consistency:** `TweakletConfig`, `GithubUser`, `sign`/`verify`, `runInit`/`InitOptions`, `createServer`/`ServerDeps`, `exchangeCodeForToken`/`fetchGithubUser` signatures match across Tasks 2–7. The server injects the same oauth function signatures the tests stub. ✓
