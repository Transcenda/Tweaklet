# tweaklet v1 — Plan 4: The Panel (React UI + serving + SPA snippet)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A signed-in user opens a slim right-panel UI (served by tweaklet) where they type a feature idea in plain language, watch the agent's progress stream in live, use the git/build console controls, and open + track a PR — all wired to the Plan 1–3 API. Deliverable: a built panel the Express server serves at `/panel`, plus a `/snippet.js` loader that injects it into a host SPA.

**Architecture:** A separate Vite + React + TypeScript package at `tweaklet/web/` (its own `package.json`, jsdom Vitest + React Testing Library — kept apart from the backend's node-Vitest). A typed API client wraps the backend endpoints; an SSE reader streams `/api/agent/prompt`. The backend Express server serves the built assets (`web/dist`) at `/panel` (auth-gated) and returns a tiny `/snippet.js` loader. Components are functional and minimal (prove the loop; visual polish is a later pass via the frontend-design skill).

**Tech Stack:** Vite, React 18, TypeScript, Vitest (jsdom) + @testing-library/react; backend Express static serving. Builds on Plans 1–3.

> **Spec:** [`../specs/2026-06-11-universal-ai-sandbox-design.md`](../specs/2026-06-11-universal-ai-sandbox-design.md) §6.3 (single right panel: chat + cursor-like progress + git/build console + post-PR lifecycle; delivered as JS snippet for SPAs / standalone tab for MPAs). Backend endpoints from Plans 1–3: `/api/me`, `/api/agent/prompt` (SSE), `/api/idea`, `/api/checkpoint`, `/api/undo`, `/api/refresh`, `/api/pr` (POST + GET).
>
> **Location:** `tweaklet/` (backend) + new `tweaklet/web/` (frontend) on `spike/ai-sandbox`. No worktree.

---

### Task 1: Scaffold the `tweaklet/web` Vite+React+TS package

**Files:** Create `tweaklet/web/package.json`, `tweaklet/web/tsconfig.json`, `tweaklet/web/vite.config.ts`, `tweaklet/web/index.html`, `tweaklet/web/src/main.tsx`, `tweaklet/web/src/smoke.test.tsx`.

- [ ] **Step 1: `tweaklet/web/package.json`**
```json
{
  "name": "tweaklet-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": {
    "@testing-library/react": "^16.0.1",
    "@testing-library/jest-dom": "^6.5.0",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```
- [ ] **Step 2: `tweaklet/web/tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx",
    "module": "ESNext", "moduleResolution": "bundler", "strict": true,
    "esModuleInterop": true, "skipLibCheck": true, "noEmit": true, "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```
- [ ] **Step 3: `tweaklet/web/vite.config.ts`** (base `/panel/` so assets resolve when served under `/panel`)
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/panel/",
  plugins: [react()],
  build: { outDir: "dist" },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/setupTests.ts"] },
});
```
- [ ] **Step 4: `tweaklet/web/src/setupTests.ts`**
```ts
import "@testing-library/jest-dom/vitest";
```
- [ ] **Step 5: `tweaklet/web/index.html`**
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>tweaklet</title></head>
<body><div id="tweaklet-root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```
- [ ] **Step 6: `tweaklet/web/src/main.tsx`**
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Panel } from "./Panel.js";

const el = document.getElementById("tweaklet-root");
if (el) createRoot(el).render(<StrictMode><Panel /></StrictMode>);
```
- [ ] **Step 7: `tweaklet/web/src/smoke.test.tsx`**
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

describe("toolchain", () => {
  it("renders", () => {
    render(<div>tweaklet ok</div>);
    expect(screen.getByText("tweaklet ok")).toBeInTheDocument();
  });
});
```
- [ ] **Step 8: install + smoke**
Run: `cd /Users/joseph/Projects/transcenda/t8a/tweaklet/web && npm install && npm test`. Expected: PASS (1 test). (`Panel.js`/`main.tsx` won't typecheck until Task 3 — `npm test` only runs the smoke test; do NOT run `npm run build` yet.)
- [ ] **Step 9: commit**
```bash
git add tweaklet/web/package.json tweaklet/web/tsconfig.json tweaklet/web/vite.config.ts tweaklet/web/index.html tweaklet/web/src/main.tsx tweaklet/web/src/setupTests.ts tweaklet/web/src/smoke.test.tsx tweaklet/web/package-lock.json
git commit -m "chore(tweaklet/web): scaffold Vite+React+TS panel package"
```

---

### Task 2: Typed API client + SSE reader

**Files:** Create `tweaklet/web/src/api.ts`, `tweaklet/web/src/api.test.ts`.

> All requests use `credentials: "include"` (the auth is the `apz_session` cookie). The SSE reader parses `data: <json>\n\n` frames from `/api/agent/prompt` into objects, invoking `onEvent` per frame until a `{type:"end"}` frame.

- [ ] **Step 1: Failing test** (`tweaklet/web/src/api.test.ts`)
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { api, streamPrompt } from "./api.js";

afterEach(() => vi.restoreAllMocks());

function jsonResp(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

describe("api", () => {
  it("me() returns the user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({ login: "alice", id: 7 })));
    expect(await api.me()).toEqual({ login: "alice", id: 7 });
  });

  it("me() returns null on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({ error: "unauthorized" }, 401)));
    expect(await api.me()).toBeNull();
  });

  it("startIdea posts the idea and returns the branch", async () => {
    const f = vi.fn(async () => jsonResp({ branch: "sandbox/alice-x" }));
    vi.stubGlobal("fetch", f);
    expect(await api.startIdea("make it bigger")).toEqual({ branch: "sandbox/alice-x" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/idea");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ idea: "make it bigger" });
    expect(init.credentials).toBe("include");
  });

  it("createPr posts and returns the url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResp({ url: "https://gh/pr/9" })));
    expect(await api.createPr("Bigger box")).toEqual({ url: "https://gh/pr/9" });
  });

  it("streamPrompt parses SSE frames into events until end", async () => {
    const frames = [
      'data: {"type":"message","role":"assistant","text":"working"}\n\n',
      'data: {"type":"tool_use","toolName":"write"}\n\n',
      'data: {"type":"end","code":0}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body } as unknown as Response)));
    const got: any[] = [];
    const end = await streamPrompt("hi", (e) => got.push(e));
    expect(got.map((e) => e.type)).toEqual(["message", "tool_use"]);
    expect(end).toEqual({ type: "end", code: 0 });
  });
});
```
Run `cd tweaklet/web && npx vitest run src/api.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement** (`tweaklet/web/src/api.ts`)
```ts
export interface User { login: string; id: number; }

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  async me(): Promise<User | null> {
    const res = await fetch("/api/me", { credentials: "include" });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`/api/me failed: ${res.status}`);
    return (await res.json()) as User;
  },
  startIdea: (idea: string) => post<{ branch: string }>("/api/idea", { idea }),
  checkpoint: (message?: string) => post<void>("/api/checkpoint", { message }),
  undo: () => post<void>("/api/undo"),
  refresh: () => post<{ reloaded: boolean; ranCommand: string | null }>("/api/refresh"),
  createPr: (title?: string) => post<{ url: string }>("/api/pr", { title }),
  prStatus: () => get<{ state: string; isDraft: boolean; url: string; reviews: { author: string; state: string; body: string }[] }>("/api/pr"),
};

export interface EndFrame { type: "end"; code: number; }

export async function streamPrompt(prompt: string, onEvent: (e: any) => void): Promise<EndFrame | null> {
  const res = await fetch("/api/agent/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok || !res.body) throw new Error(`/api/agent/prompt failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let end: EndFrame | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.startsWith("data: ") ? frame.slice(6) : frame.replace(/^data:\s?/, "");
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type === "end") { end = obj as EndFrame; } else { onEvent(obj); }
    }
  }
  return end;
}
```
Run the test → PASS (5).

- [ ] **Step 3: full suite + commit**
`npm test` (2 files pass). Then:
```bash
git add tweaklet/web/src/api.ts tweaklet/web/src/api.test.ts
git commit -m "feat(tweaklet/web): typed API client + SSE prompt reader"
```

---

### Task 3: The `<Panel>` component

**Files:** Create `tweaklet/web/src/Panel.tsx`, `tweaklet/web/src/Panel.test.tsx`.

> Functional, minimal. On mount, calls `api.me()`; if null → renders a "Sign in with GitHub" link to `/auth/login`. When signed in: a prompt textarea + Send (calls `streamPrompt`, appending each event's summary to a progress log), and the control row. The API module is mocked in tests via `vi.mock`.

- [ ] **Step 1: Failing test** (`tweaklet/web/src/Panel.test.tsx`)
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const apiMock = {
  me: vi.fn(),
  startIdea: vi.fn(),
  checkpoint: vi.fn(),
  undo: vi.fn(),
  refresh: vi.fn(),
  createPr: vi.fn(),
  prStatus: vi.fn(),
};
const streamPrompt = vi.fn();
vi.mock("./api.js", () => ({ api: apiMock, streamPrompt }));

import { Panel } from "./Panel.js";

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.me.mockResolvedValue({ login: "alice", id: 7 });
});

describe("Panel", () => {
  it("shows a sign-in link when unauthenticated", async () => {
    apiMock.me.mockResolvedValueOnce(null);
    render(<Panel />);
    const link = await screen.findByRole("link", { name: /sign in with github/i });
    expect(link).toHaveAttribute("href", "/auth/login");
  });

  it("greets the signed-in user and exposes the controls", async () => {
    render(<Panel />);
    expect(await screen.findByText(/alice/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start a new idea/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ready to go prod/i })).toBeInTheDocument();
  });

  it("sends a prompt and renders streamed progress", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "message", role: "assistant", text: "on it" });
      onEvent({ type: "tool_use", toolName: "write" });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByText(/alice/i);
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "make it bigger" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledWith("make it bigger", expect.any(Function)));
    expect(await screen.findByText(/on it/i)).toBeInTheDocument();
    expect(await screen.findByText(/write/i)).toBeInTheDocument();
  });

  it("'Ready to go prod' opens a PR and shows the link", async () => {
    apiMock.createPr.mockResolvedValue({ url: "https://gh/pr/9" });
    render(<Panel />);
    await screen.findByText(/alice/i);
    fireEvent.click(screen.getByRole("button", { name: /ready to go prod/i }));
    const link = await screen.findByRole("link", { name: /view pr/i });
    expect(link).toHaveAttribute("href", "https://gh/pr/9");
  });
});
```
Run `npx vitest run src/Panel.test.tsx` → FAIL (module missing).

- [ ] **Step 2: Implement** (`tweaklet/web/src/Panel.tsx`)
```tsx
import { useEffect, useState } from "react";
import { api, streamPrompt, type User } from "./api.js";

function summarize(e: any): string {
  if (e.type === "message") return e.text || "";
  if (e.type === "tool_use") return `▸ ${e.toolName ?? "tool"}`;
  if (e.type === "tool_result") return `✓ ${e.toolId ?? "tool"}`;
  if (e.type === "error") return `error: ${e.message}`;
  return "";
}

export function Panel() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  useEffect(() => { api.me().then(setUser).catch(() => setUser(null)); }, []);

  if (user === undefined) return <div className="apz-panel">Loading…</div>;
  if (user === null)
    return (
      <div className="apz-panel">
        <p>Sign in to start.</p>
        <a href="/auth/login">Sign in with GitHub</a>
      </div>
    );

  const append = (s: string) => { if (s) setLog((l) => [...l, s]); };

  async function send() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    append(`You: ${prompt}`);
    try {
      await streamPrompt(prompt, (e) => append(summarize(e)));
    } catch (err) {
      append(`error: ${String(err)}`);
    } finally {
      setBusy(false);
      setPrompt("");
    }
  }

  async function ctl(fn: () => Promise<unknown>, label: string) {
    setBusy(true);
    try { await fn(); append(label); } catch (e) { append(`error: ${String(e)}`); } finally { setBusy(false); }
  }

  return (
    <div className="apz-panel">
      <header>Signed in as <b>{user.login}</b></header>
      <div className="apz-log" data-testid="log">
        {log.map((line, i) => (<div key={i}>{line}</div>))}
      </div>
      <textarea placeholder="Describe a change…" value={prompt} disabled={busy}
        onChange={(e) => setPrompt(e.target.value)} />
      <div className="apz-actions">
        <button onClick={send} disabled={busy}>Send</button>
      </div>
      <div className="apz-controls">
        <button disabled={busy} onClick={() => ctl(() => api.startIdea(prompt || "new idea"), "◆ new idea")}>Start a new idea</button>
        <button disabled={busy} onClick={() => ctl(() => api.refresh(), "↻ refreshed")}>Refresh app</button>
        <button disabled={busy} onClick={() => ctl(() => api.checkpoint(), "⚑ checkpoint")}>Save checkpoint</button>
        <button disabled={busy} onClick={() => ctl(() => api.undo(), "⤺ undo")}>Undo</button>
        <button disabled={busy} onClick={() => ctl(async () => { const { url } = await api.createPr(prompt || undefined); setPrUrl(url); }, "✓ sent to prod")}>Ready to go prod</button>
      </div>
      {prUrl && <a href={prUrl}>View PR</a>}
    </div>
  );
}
```
Run the test → PASS (4). Then `npm run build` in `tweaklet/web` (now that `Panel.tsx` exists, the full build typechecks) → exit 0.

- [ ] **Step 3: full suite + commit**
`npm test` (3 files pass). Then:
```bash
git add tweaklet/web/src/Panel.tsx tweaklet/web/src/Panel.test.tsx
git commit -m "feat(tweaklet/web): Panel component (auth gate, prompt+progress, controls, PR)"
```

---

### Task 4: Serve the panel + `/snippet.js` from the backend

**Files:** Modify `tweaklet/src/server/server.ts`; create `tweaklet/src/server/panel-routes.test.ts`.

> Serve the built `web/dist` at `/panel` (static), and a `GET /snippet.js` returning a small loader that injects an iframe pointing at `/panel` into a host SPA. The panel route does not need the auth gate itself (the API calls it makes are gated); `/snippet.js` is public JS. Resolve `web/dist` relative to the compiled file via `import.meta.url`.

- [ ] **Step 1: Failing test** (`tweaklet/src/server/panel-routes.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import type { TweakletConfig } from "../config/config.js";

const config: TweakletConfig = {
  github: { clientId: "c", clientSecret: "s", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
};

describe("panel routes", () => {
  it("GET /snippet.js returns javascript that targets /panel", async () => {
    const res = await request(createServer(config)).get("/snippet.js").expect(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.text).toContain("/panel");
  });
});
```
Run `cd /Users/joseph/Projects/transcenda/t8a/tweaklet && npx vitest run src/server/panel-routes.test.ts` → FAIL.

- [ ] **Step 2: Implement** — in `src/server/server.ts`:

(a) Imports near the top:
```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
```
(b) After `const app = express();` (and the existing `express.json()`), add the panel + snippet routes (place before the catch-all `GET /`):
```ts
  app.get("/snippet.js", (_req, res) => {
    res.type("application/javascript").send(
      `(function(){var f=document.createElement('iframe');f.src='/panel/';` +
      `f.style.cssText='position:fixed;top:0;right:0;width:380px;height:100%;border:0;border-left:1px solid #ddd;z-index:2147483647';` +
      `f.id='tweaklet-panel';if(!document.getElementById('tweaklet-panel'))document.body.appendChild(f);})();`
    );
  });

  // Serve the built panel (web/dist) at /panel, if present.
  const panelDir = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(panelDir)) {
    app.use("/panel", express.static(panelDir));
    app.get("/panel/*", (_req, res) => res.sendFile(join(panelDir, "index.html")));
  } else {
    app.get("/panel", (_req, res) => res.status(503).type("text/plain").send("panel not built — run `npm --prefix web run build`"));
  }
```
Run `npx vitest run src/server/panel-routes.test.ts` → PASS. Then `npx vitest run src/server/server.test.ts` → existing server tests still pass.

- [ ] **Step 3: build + full suite + commit**
`npm run build` (backend, exit 0) + `npm test`. Then:
```bash
git add src/server/server.ts src/server/panel-routes.test.ts
git commit -m "feat(tweaklet): serve the panel at /panel + /snippet.js loader"
```

---

### Task 5: Build wiring + manual E2E (operator)

**Files:** Modify `tweaklet/package.json` (a `build:web` script).

- [ ] **Step 1:** add to `tweaklet/package.json` scripts: `"build:web": "npm --prefix web install && npm --prefix web run build"` and a `"build:all": "npm run build && npm run build:web"`. Commit:
```bash
git add tweaklet/package.json && git commit -m "chore(tweaklet): build:web / build:all scripts"
```
- [ ] **Step 2 (operator, manual E2E):** With opencode + the Vertex `opencode.json` configured and `~/.tweaklet/config.json` pointing `agent`/`repo`/`run` at the **T8A** clone on the Dev Server (model pinned to `google-vertex-ai/gemini-2.5-pro` for reliability): `npm run build:all` → `tweaklet serve` → open `http://localhost:4319/panel`, sign in with GitHub → type *"make the prompt-editing textarea on the recruitment settings page taller"* → watch progress stream → **Ready to go prod** → confirm a draft PR on GitHub. Then inject into the live T8A SPA by adding `<script src="http://localhost:4319/snippet.js">` (dev only) and confirm the panel mounts.

---

## Self-Review

**Spec coverage (Plan 4 = §6.3):**
- Single right panel: auth gate + prompt + cursor-like progress (SSE) + git/build console + PR → Task 3 (`Panel`) + Task 2 (client/SSE). ✓
- "Ready to go prod" → `api.createPr` + PR link (Task 2/3). ✓
- Post-PR: `prStatus()` client method exists for review iteration; surfacing it richly in the UI is a fast-follow (Task 3 wires create + link; status display is minimal — noted). ✓ (minimal)
- Delivery as JS snippet (SPA) / standalone tab (MPA) → Task 4 (`/snippet.js` iframe loader + the standalone `/panel` route). ✓
- Backend stays the auth/source-of-truth; panel calls the gated API with the session cookie. ✓

**Placeholder scan:** none — complete code/commands; Task 5 Step 2 is the explicitly-manual operator E2E (needs real T8A + Vertex).

**Type consistency:** `api`/`streamPrompt`/`User` (Task 2) are consumed by `Panel` (Task 3) with matching shapes; the panel route paths (`/panel`, `/snippet.js`) match the client's base assumptions; the SSE frame contract (`{type:"end",code}` + AgentEvent frames) matches the backend's `send()` in the agent route (Plan 2).
