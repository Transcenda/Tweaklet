# tweaklet v1 — Plan 3: Lifecycle (git/build controls, draft PR, post-PR, live-update)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** From the panel, a signed-in user can drive a feature's whole git lifecycle on the configured repo: **start an idea** (branch from base, named per convention), **save a checkpoint** (commit), **undo** (discard to last commit), **refresh** the running app (configurable live-update), **send it to prod** (open a draft PR), and **see PR status + review comments** to iterate to merge.

**Architecture:** A real-`git` wrapper (`git/repo.ts`, shells out via `execFile`, tested against a throwaway temp repo) and a `gh`-CLI PR wrapper (`git/pr.ts`, exec injected so tests don't hit GitHub). A `run/live-update.ts` runs the configured refresh (hot-reload = the app's own dev server already reloads → no-op; rebuild-swap = run the configured rebuild command). The server exposes auth-gated lifecycle endpoints, with the `repo`/`pr`/`refresh` functions injected via `ServerDeps` so endpoints test without real git/gh.

**Tech Stack:** Node 20+ (`node:child_process` `execFile`), TypeScript (ESM), Express, Zod, Vitest + Supertest. Builds on Plans 1–2.

> **Spec:** [`../specs/2026-06-11-universal-ai-sandbox-design.md`](../specs/2026-06-11-universal-ai-sandbox-design.md) §6.3 (git/build console controls + post-PR-to-merge lifecycle), §6.4 (configurable live-update — no HMR assumption), §6.5 (PRs under the user's GitHub identity via `gh`).
>
> **Location:** `tweaklet/` on `spike/ai-sandbox`. No worktree. Continues from Plan 2.
>
> **Real-environment note:** `gh` PR creation and the real git remote are exercised only in the operator E2E (Plan 4 / smoke); these tasks test git locally (temp repo) and mock `gh`.

---

### Task 1: Config — add optional `repo` and `run` blocks

**Files:** Modify `src/config/config.ts`; add a case to `src/config/config.test.ts`.

- [ ] **Step 1: Failing test** — append inside `describe("config", ...)`:
```ts
  it("round-trips optional repo + run blocks", () => {
    const cfg = {
      ...valid,
      repo: { path: "/home/tweaklet/app", baseBranch: "main", branchPrefix: "sandbox/", prTarget: "main" },
      run: { liveUpdate: "rebuild-swap", rebuildCommand: "make build" },
    };
    saveConfig(cfg);
    const loaded = loadConfig();
    expect(loaded.repo).toEqual(cfg.repo);
    expect(loaded.run).toEqual({ liveUpdate: "rebuild-swap", rebuildCommand: "make build" });
  });

  it("defaults run.liveUpdate to hot-reload", () => {
    saveConfig({ ...valid, run: {} } as any);
    expect(loadConfig().run?.liveUpdate).toBe("hot-reload");
  });
```
Run `npx vitest run src/config/config.test.ts` → the new tests FAIL (keys stripped).

- [ ] **Step 2: Implement** — add to the top-level `ConfigSchema` object, after `agent`:
```ts
  repo: z
    .object({
      path: z.string().min(1),
      baseBranch: z.string().min(1).default("main"),
      branchPrefix: z.string().default("sandbox/"),
      prTarget: z.string().min(1).default("main"),
    })
    .optional(),
  run: z
    .object({
      liveUpdate: z.enum(["hot-reload", "rebuild-swap"]).default("hot-reload"),
      rebuildCommand: z.string().optional(),
    })
    .optional(),
```
Run `npx vitest run src/config/config.test.ts` → PASS.

- [ ] **Step 3: Full suite + commit.** `npm test` (expect 40). Then:
```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat(tweaklet): optional repo + run config blocks"
```

---

### Task 2: git repo wrapper (real git, temp-repo tests)

**Files:** Create `src/git/repo.ts`, `src/git/repo.test.ts`.

> Functions shell out to the real `git` binary in a given `cwd`. Tests run against a throwaway repo created with `git init` (real git), so they verify actual behavior. Helper `slugify` turns a free-text idea into a branch-safe slug.

- [ ] **Step 1: Failing test** (`src/git/repo.test.ts`):
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, startBranch, checkpoint, discard, slugify } from "./repo.js";

let dir: string;
function git(...args: string[]) { return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim(); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apz-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.dev"); git("config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "-A"); git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("repo", () => {
  it("slugify makes a branch-safe slug", () => {
    expect(slugify("Make the box BIGGER!")).toBe("make-the-box-bigger");
  });

  it("currentBranch reports the checked-out branch", async () => {
    expect(await currentBranch(dir)).toBe("main");
  });

  it("startBranch creates and checks out a prefixed branch from base", async () => {
    const branch = await startBranch(dir, { base: "main", prefix: "sandbox/", user: "alice", idea: "Bigger box" });
    expect(branch).toBe("sandbox/alice-bigger-box");
    expect(await currentBranch(dir)).toBe("sandbox/alice-bigger-box");
  });

  it("checkpoint commits all working changes", async () => {
    await startBranch(dir, { base: "main", prefix: "sandbox/", user: "alice", idea: "x" });
    writeFileSync(join(dir, "a.txt"), "new\n");
    await checkpoint(dir, "wip");
    expect(git("log", "--oneline", "-1")).toContain("wip");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("discard resets working changes to HEAD", async () => {
    await startBranch(dir, { base: "main", prefix: "sandbox/", user: "alice", idea: "x" });
    writeFileSync(join(dir, "README.md"), "tampered\n");
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    await discard(dir);
    expect(git("status", "--porcelain")).toBe("");
  });
});
```
Run `npx vitest run src/git/repo.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement** (`src/git/repo.ts`):
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd });
  return stdout.trim();
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "idea";
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function startBranch(
  cwd: string,
  opts: { base: string; prefix: string; user: string; idea: string },
): Promise<string> {
  const branch = `${opts.prefix}${slugify(opts.user)}-${slugify(opts.idea)}`;
  await git(cwd, ["checkout", opts.base]);
  await git(cwd, ["checkout", "-B", branch]);
  return branch;
}

export async function checkpoint(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", message]);
}

export async function discard(cwd: string): Promise<void> {
  await git(cwd, ["reset", "--hard", "HEAD"]);
  await git(cwd, ["clean", "-fd"]);
}
```
Run `npx vitest run src/git/repo.test.ts` → PASS (5 tests).

- [ ] **Step 3: Full suite + commit.** `npm test` (expect 45). Then:
```bash
git add src/git/repo.ts src/git/repo.test.ts
git commit -m "feat(tweaklet): git repo wrapper (start branch, checkpoint, discard)"
```

---

### Task 3: gh PR wrapper (exec injected)

**Files:** Create `src/git/pr.ts`, `src/git/pr.test.ts`.

> Shells out to `gh` (authed as the user). The exec is injected so tests assert the exact argv and parse canned output without hitting GitHub. `createDraftPr` returns the PR URL; `prStatus` parses `gh pr view --json`.

- [ ] **Step 1: Failing test** (`src/git/pr.test.ts`):
```ts
import { describe, it, expect } from "vitest";
import { createDraftPr, prStatus, type Exec } from "./pr.js";

describe("pr", () => {
  it("createDraftPr pushes the branch and opens a draft PR, returning the URL", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "gh") return { stdout: "https://github.com/acme/app/pull/7\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const url = await createDraftPr("/repo", { branch: "sandbox/alice-x", title: "Bigger box", body: "by alice", base: "main" }, exec);
    expect(url).toBe("https://github.com/acme/app/pull/7");
    expect(calls.find((c) => c.cmd === "git")?.args).toEqual(["push", "-u", "origin", "sandbox/alice-x"]);
    const gh = calls.find((c) => c.cmd === "gh")!;
    expect(gh.args).toEqual(["pr", "create", "--draft", "--base", "main", "--head", "sandbox/alice-x", "--title", "Bigger box", "--body", "by alice"]);
  });

  it("prStatus parses gh pr view --json", async () => {
    const exec: Exec = async () => ({
      stdout: JSON.stringify({ state: "OPEN", isDraft: true, url: "u", reviews: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "rename it" }] }),
      stderr: "", code: 0,
    });
    const s = await prStatus("/repo", "sandbox/alice-x", exec);
    expect(s).toMatchObject({ state: "OPEN", isDraft: true });
    expect(s.reviews[0]).toMatchObject({ author: "bob", state: "CHANGES_REQUESTED", body: "rename it" });
  });

  it("createDraftPr throws if gh fails", async () => {
    const exec: Exec = async (cmd) => (cmd === "gh" ? { stdout: "", stderr: "no auth", code: 1 } : { stdout: "", stderr: "", code: 0 });
    await expect(createDraftPr("/repo", { branch: "b", title: "t", body: "x", base: "main" }, exec)).rejects.toThrow(/gh pr create failed/);
  });
});
```
Run `npx vitest run src/git/pr.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement** (`src/git/pr.ts`):
```ts
import { execFile } from "node:child_process";

export interface ExecResult { stdout: string; stderr: string; code: number; }
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

const realExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0 });
    });
  });

export async function createDraftPr(
  cwd: string,
  opts: { branch: string; title: string; body: string; base: string },
  exec: Exec = realExec,
): Promise<string> {
  const push = await exec("git", ["push", "-u", "origin", opts.branch], cwd);
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr}`);
  const r = await exec("gh", ["pr", "create", "--draft", "--base", opts.base, "--head", opts.branch, "--title", opts.title, "--body", opts.body], cwd);
  if (r.code !== 0) throw new Error(`gh pr create failed: ${r.stderr}`);
  return r.stdout.trim();
}

export interface PrStatus {
  state: string;
  isDraft: boolean;
  url: string;
  reviews: { author: string; state: string; body: string }[];
}

export async function prStatus(cwd: string, branch: string, exec: Exec = realExec): Promise<PrStatus> {
  const r = await exec("gh", ["pr", "view", branch, "--json", "state,isDraft,url,reviews"], cwd);
  if (r.code !== 0) throw new Error(`gh pr view failed: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  return {
    state: j.state,
    isDraft: !!j.isDraft,
    url: j.url,
    reviews: (j.reviews ?? []).map((rv: any) => ({ author: rv.author?.login ?? "", state: rv.state, body: rv.body ?? "" })),
  };
}
```
Run `npx vitest run src/git/pr.test.ts` → PASS (3 tests).

- [ ] **Step 3: Full suite + commit.** `npm test` (expect 48). Then:
```bash
git add src/git/pr.ts src/git/pr.test.ts
git commit -m "feat(tweaklet): gh PR wrapper (create draft PR, parse PR status/reviews)"
```

---

### Task 4: live-update

**Files:** Create `src/run/live-update.ts`, `src/run/live-update.test.ts`.

> `refresh(runConfig, cwd, exec)`: for `hot-reload`, the app's own dev server already reloads on file change → return `{ reloaded: false, ranCommand: null }` (nothing to do). For `rebuild-swap`, run `runConfig.rebuildCommand` (throw if it's missing) → `{ reloaded: true, ranCommand }`.

- [ ] **Step 1: Failing test** (`src/run/live-update.test.ts`):
```ts
import { describe, it, expect } from "vitest";
import { refresh, type Exec } from "./live-update.js";

const okExec: Exec = async () => ({ stdout: "built", stderr: "", code: 0 });

describe("refresh", () => {
  it("hot-reload is a no-op (dev server reloads itself)", async () => {
    const r = await refresh({ liveUpdate: "hot-reload" }, "/app", okExec);
    expect(r).toEqual({ reloaded: false, ranCommand: null });
  });

  it("rebuild-swap runs the configured rebuild command", async () => {
    let ran: string[] | null = null;
    const exec: Exec = async (cmd, args) => { ran = [cmd, ...args]; return { stdout: "", stderr: "", code: 0 }; };
    const r = await refresh({ liveUpdate: "rebuild-swap", rebuildCommand: "make build" }, "/app", exec);
    expect(r).toEqual({ reloaded: true, ranCommand: "make build" });
    expect(ran).toEqual(["sh", "-c", "make build"]);
  });

  it("rebuild-swap throws if no rebuildCommand configured", async () => {
    await expect(refresh({ liveUpdate: "rebuild-swap" }, "/app", okExec)).rejects.toThrow(/rebuildCommand/);
  });

  it("rebuild-swap throws if the command exits nonzero", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "boom", code: 2 });
    await expect(refresh({ liveUpdate: "rebuild-swap", rebuildCommand: "false" }, "/app", exec)).rejects.toThrow(/rebuild failed/);
  });
});
```
Run `npx vitest run src/run/live-update.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement** (`src/run/live-update.ts`):
```ts
import { execFile } from "node:child_process";

export interface ExecResult { stdout: string; stderr: string; code: number; }
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

const realExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0 });
    });
  });

export interface RunConfig {
  liveUpdate: "hot-reload" | "rebuild-swap";
  rebuildCommand?: string;
}

export interface RefreshResult { reloaded: boolean; ranCommand: string | null; }

export async function refresh(run: RunConfig, cwd: string, exec: Exec = realExec): Promise<RefreshResult> {
  if (run.liveUpdate === "hot-reload") {
    return { reloaded: false, ranCommand: null };
  }
  if (!run.rebuildCommand) throw new Error("rebuild-swap requires a rebuildCommand");
  const r = await exec("sh", ["-c", run.rebuildCommand], cwd);
  if (r.code !== 0) throw new Error(`rebuild failed (exit ${r.code}): ${r.stderr}`);
  return { reloaded: true, ranCommand: run.rebuildCommand };
}
```
Run `npx vitest run src/run/live-update.test.ts` → PASS (4 tests).

- [ ] **Step 3: Full suite + commit.** `npm test` (expect 52). Then:
```bash
git add src/run/live-update.ts src/run/live-update.test.ts
git commit -m "feat(tweaklet): live-update (hot-reload no-op / rebuild-swap command)"
```

---

### Task 5: Lifecycle endpoints

**Files:** Modify `src/server/server.ts`; create `src/server/lifecycle-routes.test.ts`.

> Auth-gated endpoints, each backed by an injectable function so tests run without real git/gh. All require `config.repo`; PR endpoints also use `config.repo.prTarget`. The branch for the active idea is tracked per server instance (single-session v1) — `currentBranch(repo.path)` is the source of truth.
>
> Endpoints:
> - `POST /api/idea` `{ idea }` → `startBranch` → `{ branch }`
> - `POST /api/checkpoint` `{ message? }` → `checkpoint` → `204`
> - `POST /api/undo` → `discard` → `204`
> - `POST /api/refresh` → `refresh(config.run)` → `{ reloaded, ranCommand }`
> - `POST /api/pr` `{ title?, body? }` → `createDraftPr` from current branch → `{ url }`
> - `GET /api/pr` → `prStatus` of current branch → the status JSON

- [ ] **Step 1: Failing test** (`src/server/lifecycle-routes.test.ts`):
```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createServer } from "./server.js";
import { sign } from "../auth/signing.js";
import type { TweakletConfig } from "../config/config.js";

const config: TweakletConfig = {
  github: { clientId: "cid", clientSecret: "sec", oauthBaseUrl: "https://github.com", apiBaseUrl: "https://api.github.com" },
  server: { port: 4319, publicUrl: "http://localhost:4319", sessionSecret: "z".repeat(32) },
  repo: { path: "/repo", baseBranch: "main", branchPrefix: "sandbox/", prTarget: "main" },
  run: { liveUpdate: "hot-reload" },
};
const cookie = `apz_session=${sign({ login: "alice", id: 7 }, config.server.sessionSecret)}`;

const lifecycle = {
  startBranch: async (_cwd: string, o: any) => `sandbox/${o.user}-${o.idea.toLowerCase().replace(/\W+/g, "-")}`,
  currentBranch: async () => "sandbox/alice-bigger",
  checkpoint: async () => {},
  discard: async () => {},
  refresh: async () => ({ reloaded: false, ranCommand: null }),
  createDraftPr: async () => "https://github.com/acme/app/pull/9",
  prStatus: async () => ({ state: "OPEN", isDraft: true, url: "u", reviews: [] }),
};

function app(extra = {}) {
  return createServer(config, { exchangeCodeForToken: async () => "t", fetchGithubUser: async () => ({ login: "alice", id: 7 }), lifecycle: { ...lifecycle, ...extra } } as any);
}

describe("lifecycle endpoints", () => {
  it("all require auth", async () => {
    for (const [m, p] of [["post", "/api/idea"], ["post", "/api/checkpoint"], ["post", "/api/undo"], ["post", "/api/refresh"], ["post", "/api/pr"], ["get", "/api/pr"]] as const) {
      await (request(app()) as any)[m](p).expect(401);
    }
  });

  it("POST /api/idea starts a branch named per convention", async () => {
    const res = await request(app()).post("/api/idea").set("Cookie", cookie).send({ idea: "Bigger" }).expect(200);
    expect(res.body.branch).toContain("sandbox/alice-");
  });

  it("POST /api/checkpoint and /api/undo return 204", async () => {
    await request(app()).post("/api/checkpoint").set("Cookie", cookie).send({ message: "wip" }).expect(204);
    await request(app()).post("/api/undo").set("Cookie", cookie).send().expect(204);
  });

  it("POST /api/refresh returns the refresh result", async () => {
    const res = await request(app()).post("/api/refresh").set("Cookie", cookie).send().expect(200);
    expect(res.body).toEqual({ reloaded: false, ranCommand: null });
  });

  it("POST /api/pr opens a draft PR from the current branch", async () => {
    const res = await request(app()).post("/api/pr").set("Cookie", cookie).send({ title: "Bigger box" }).expect(200);
    expect(res.body.url).toContain("/pull/");
  });

  it("GET /api/pr returns PR status", async () => {
    const res = await request(app()).get("/api/pr").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ state: "OPEN", isDraft: true });
  });

  it("400s when repo is not configured", async () => {
    const noRepo = createServer({ ...config, repo: undefined }, { exchangeCodeForToken: async () => "t", fetchGithubUser: async () => ({ login: "alice", id: 7 }), lifecycle } as any);
    await request(noRepo).post("/api/idea").set("Cookie", cookie).send({ idea: "x" }).expect(400);
  });
});
```
Run `npx vitest run src/server/lifecycle-routes.test.ts` → FAIL.

- [ ] **Step 2: Implement** in `src/server/server.ts`:

(a) Imports near the top:
```ts
import * as repoLib from "../git/repo.js";
import * as prLib from "../git/pr.js";
import { refresh as realRefresh } from "../run/live-update.js";
```

(b) Define an injectable lifecycle bundle. Add to `ServerDeps`:
```ts
  lifecycle?: {
    startBranch: typeof repoLib.startBranch;
    currentBranch: typeof repoLib.currentBranch;
    checkpoint: typeof repoLib.checkpoint;
    discard: typeof repoLib.discard;
    refresh: typeof realRefresh;
    createDraftPr: typeof prLib.createDraftPr;
    prStatus: typeof prLib.prStatus;
  };
```

(c) Inside `createServer`, after the agent wiring:
```ts
  const lc = deps.lifecycle ?? {
    startBranch: repoLib.startBranch,
    currentBranch: repoLib.currentBranch,
    checkpoint: repoLib.checkpoint,
    discard: repoLib.discard,
    refresh: realRefresh,
    createDraftPr: prLib.createDraftPr,
    prStatus: prLib.prStatus,
  };
  function requireRepo(res: import("express").Response): boolean {
    if (!config.repo) { res.status(400).json({ error: "no repo configured" }); return false; }
    return true;
  }
```

(d) Routes (after the agent route). Each is auth-gated and wrapped in try/catch → 500 with `{error}` on failure:
```ts
  app.post("/api/idea", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    try {
      const idea = String(req.body?.idea ?? "").trim();
      if (!idea) { res.status(400).json({ error: "empty idea" }); return; }
      const user = currentUser(req)!;
      const branch = await lc.startBranch(config.repo!.path, { base: config.repo!.baseBranch, prefix: config.repo!.branchPrefix, user: user.login, idea });
      res.json({ branch });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post("/api/checkpoint", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    try {
      const message = String(req.body?.message ?? "checkpoint").trim() || "checkpoint";
      await lc.checkpoint(config.repo!.path, message);
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post("/api/undo", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try { await lc.discard(config.repo!.path); res.status(204).end(); }
    catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post("/api/refresh", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try { res.json(await lc.refresh(config.run ?? { liveUpdate: "hot-reload" }, config.repo!.path)); }
    catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post("/api/pr", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    try {
      const branch = await lc.currentBranch(config.repo!.path);
      const user = currentUser(req)!;
      const title = String(req.body?.title ?? branch).trim() || branch;
      const body = String(req.body?.body ?? `Prototyped via tweaklet by ${user.login}.`);
      const url = await lc.createDraftPr(config.repo!.path, { branch, title, body, base: config.repo!.prTarget });
      res.json({ url });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get("/api/pr", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      const branch = await lc.currentBranch(config.repo!.path);
      res.json(await lc.prStatus(config.repo!.path, branch));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
```

Run `npx vitest run src/server/lifecycle-routes.test.ts` → PASS. Then `npx vitest run src/server/server.test.ts src/server/agent-routes.test.ts` to confirm earlier server tests still pass.

- [ ] **Step 3: build + full suite + commit.** `npm run build` (clean) + `npm test` (expect ~60). Then:
```bash
git add src/server/server.ts src/server/lifecycle-routes.test.ts
git commit -m "feat(tweaklet): lifecycle endpoints (idea/checkpoint/undo/refresh/pr)"
```

---

### Task 6: Manual smoke (real git + gh) — operator step

**Files:** none.

- [ ] With `repo`/`run` configured in `~/.tweaklet/config.json`, the repo cloned at `repo.path`, and `gh` authed as the user, drive the loop via the API (or the panel once Plan 4 lands): `POST /api/idea` → edit a file (or via the agent) → `POST /api/checkpoint` → `POST /api/pr` → confirm a **draft PR** appears on GitHub under the user → push a follow-up commit + `GET /api/pr` shows it → request changes as a reviewer → confirm `GET /api/pr` surfaces the review comment. Adjust `git/pr.ts` field mapping if `gh`'s `--json` keys differ, and commit any fix.

---

## Self-Review

**Spec coverage (Plan 3 = §6.3 controls + post-PR lifecycle, §6.4 live-update, §6.5 PR-under-user):**
- Start idea / checkpoint / undo / refresh / ready-to-go-prod (draft PR) → Task 5 endpoints, backed by Tasks 2 (git) + 4 (live-update) + 3 (PR). ✓
- Branch naming per convention → `startBranch` uses `config.repo.branchPrefix` + slugified user + idea (Task 2 test asserts `sandbox/alice-bigger-box`). ✓
- Post-PR-to-merge: push follow-ups (re-`checkpoint` then the branch is already pushed; `GET /api/pr` reflects status) + surface review comments (`prStatus.reviews`) → Tasks 3 + 5 + the Task 6 smoke. ✓
- Configurable live-update, no HMR assumption → Task 4 (`hot-reload` no-op vs `rebuild-swap` command). ✓
- PR under the user's identity via `gh` → `createDraftPr` shells `gh` (authed as the user); Task 6 confirms on real GitHub. ✓
- App-level auth on every control → `authGate` on all routes (Task 5 "all require auth" test). ✓

**Placeholder scan:** none — complete code/commands throughout; Task 6 is the explicitly-manual operator smoke (needs real git remote + gh).

**Type consistency:** `repo`/`run` config shapes (Task 1) match Task 2/4/5 usage; the injected `lifecycle` bundle signatures in `ServerDeps` (Task 5) match `repo.ts`/`pr.ts`/`live-update.ts` exports; `Exec`/`ExecResult` are defined in both `pr.ts` and `live-update.ts` (intentional small duplication to keep modules independent — a shared `exec.ts` is a possible later DRY-up, noted, not required).
