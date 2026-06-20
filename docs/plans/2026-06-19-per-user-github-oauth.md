# Tweaklet Per-User UI GitHub Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every git operation (clone, commit, push, PR) run under the **signed-in user's own GitHub OAuth token**, captured in the web UI — eliminating the operator-side `gh auth login` + `git config` and their setup checks.

**Architecture:** The OAuth sign-in (broadened to `repo read:user user:email`) now *keeps* the access token in an in-server, per-login map (never persisted/cookie'd). Git auth is injected per-invocation via `GIT_ASKPASS` (token in an env var, never in `.git/config`); commits are authored with `-c user.name/-c user.email` from the OAuth profile; PRs go through the GitHub REST API with the token. `gh` is dropped entirely.

**Tech Stack:** Node/TS ESM (`@tweaklet/server`, Express, vitest), Vite/React panel. Spec: `tweaklet/docs/specs/2026-06-18-per-user-github-oauth-design.md`. Branch `feat/tweaklet-pluggable-onboarding` (PR #85).

**Gate (run from `tweaklet/`):** `npm run build && npm test` (server) + `npm --prefix web run build && npm --prefix web test` (web).

## DO NOT
- No commits to `main`. No `--no-verify` / force-push. Keep the `parseRepoRef`/`isRepoAllowed`/`assertSafeRef` safety in `clone.ts`/`repo.ts`/`pr.ts` — only the *transport/auth* changes. Never log or persist the token; never put it in a cookie or `.git/config`.

## File Structure
- **Create** `src/git/token-git.ts` — `GIT_ASKPASS` token-injection env helper (one responsibility: make git authenticate as a token without persisting it).
- **Modify** `src/auth/github-oauth.ts` — scopes + return `name`/`email`.
- **Modify** `src/git/clone.ts` — token git clone; drop `gh`; keep allowlist.
- **Modify** `src/git/repo.ts` — per-user commit author.
- **Modify** `src/git/pr.ts` — token push + REST PR; drop `gh`.
- **Modify** `src/doctor/doctor.ts` + `src/server/setup-state.ts` — drop gh-auth/git-identity checks.
- **Modify** `src/server/server.ts` — capture token on callback; in-server token map; thread token/author into clone/commit/pr routes; new `POST /agent/clone`; `/setup/repo` → allowlist config.
- **Modify** web `src/api.ts`, `src/SetupWizard.tsx`, `src/Panel.tsx` — allowlist setup step; post-sign-in repo pick + clone.

> Note: the spec mentioned a separate `auth/session-store.ts`; we instead use an in-`createServer` `Map` keyed by login (mirrors the existing `sessions` map) — same behavior, less surface, and the token never leaves the server module.

---

### Task 1: OAuth scopes + capture name/email

**Files:** Modify `src/auth/github-oauth.ts`; Test `src/auth/github-oauth.test.ts`.

- [ ] **Step 1: Write failing tests** — append to `github-oauth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, fetchGithubUser } from "./github-oauth.js";

describe("oauth scope", () => {
  it("requests repo + read:user + user:email", () => {
    const url = buildAuthorizeUrl({ clientId: "c", redirectUri: "https://h/cb", state: "s", oauthBaseUrl: "https://github.com" });
    expect(new URL(url).searchParams.get("scope")).toBe("repo read:user user:email");
  });
});

describe("fetchGithubUser name/email", () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as Response);
  it("returns name + public email from /user", async () => {
    const f = (async (u: string) => u.endsWith("/user") ? ok({ login: "alice", id: 7, name: "Alice A", email: "alice@x.com" }) : ok([])) as typeof fetch;
    const u = await fetchGithubUser({ token: "t", apiBaseUrl: "https://api.github.com" }, f);
    expect(u).toMatchObject({ login: "alice", id: 7, name: "Alice A", email: "alice@x.com" });
  });
  it("falls back to /user/emails primary when /user email is null", async () => {
    const f = (async (u: string) =>
      u.endsWith("/user") ? ok({ login: "alice", id: 7, name: null, email: null })
        : ok([{ email: "p@x.com", primary: true, verified: true }])) as typeof fetch;
    const u = await fetchGithubUser({ token: "t", apiBaseUrl: "https://api.github.com" }, f);
    expect(u.email).toBe("p@x.com");
    expect(u.name).toBe("alice"); // name falls back to login
  });
  it("falls back to noreply email when none available", async () => {
    const f = (async (u: string) => u.endsWith("/user") ? ok({ login: "alice", id: 7 }) : ok([])) as typeof fetch;
    const u = await fetchGithubUser({ token: "t", apiBaseUrl: "https://api.github.com" }, f);
    expect(u.email).toBe("7+alice@users.noreply.github.com");
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/auth/github-oauth.test.ts` → fails (scope is `"repo"`, no name/email).

- [ ] **Step 3: Implement** — in `github-oauth.ts`:

```ts
// buildAuthorizeUrl: change the scope line
u.searchParams.set("scope", "repo read:user user:email");

// widen the interface
export interface GithubUser { login: string; id: number; name: string; email: string; }

// rewrite fetchGithubUser
export async function fetchGithubUser(
  args: { token: string; apiBaseUrl: string },
  fetchImpl: FetchLike = fetch,
): Promise<GithubUser> {
  const h = { Authorization: `Bearer ${args.token}`, Accept: "application/vnd.github+json" };
  const res = await fetchImpl(`${args.apiBaseUrl}/user`, { headers: h });
  if (!res.ok) throw new Error(`fetch user failed: ${res.status}`);
  const body = (await res.json()) as { login: string; id: number; name?: string | null; email?: string | null };
  let email = body.email ?? undefined;
  if (!email) {
    try {
      const er = await fetchImpl(`${args.apiBaseUrl}/user/emails`, { headers: h });
      if (er.ok) {
        const emails = (await er.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))?.email;
      }
    } catch { /* fall through to noreply */ }
  }
  if (!email) email = `${body.id}+${body.login}@users.noreply.github.com`;
  return { login: body.login, id: body.id, name: body.name || body.login, email };
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/auth/github-oauth.test.ts` → all pass. (Existing 3 tests still pass — they don't assert the scope/email.)

- [ ] **Step 5: Commit** — `git add src/auth/github-oauth.ts src/auth/github-oauth.test.ts && git commit -m "feat(tweaklet): OAuth repo scope + capture name/email"`

---

### Task 2: `token-git.ts` — GIT_ASKPASS token injection

**Files:** Create `src/git/token-git.ts`; Test `src/git/token-git.test.ts`.

- [ ] **Step 1: Write failing test** — `src/git/token-git.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { tokenGitEnv, ensureAskpass } from "./token-git.js";

const run = promisify(execFile);

describe("tokenGitEnv", () => {
  it("returns GIT_ASKPASS + token env (token NOT on argv)", () => {
    const env = tokenGitEnv("ghs_abc");
    expect(existsSync(env.GIT_ASKPASS!)).toBe(true);
    expect(env.TWEAKLET_GIT_TOKEN).toBe("ghs_abc");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("the askpass script answers username=x-access-token and password=<token>", async () => {
    const p = ensureAskpass();
    const e = { ...process.env, TWEAKLET_GIT_TOKEN: "ghs_secret" };
    const user = await run(p, ["Username for 'https://github.com': "], { env: e });
    const pass = await run(p, ["Password for 'https://github.com': "], { env: e });
    expect(user.stdout).toBe("x-access-token");
    expect(pass.stdout).toBe("ghs_secret");
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/git/token-git.test.ts` → fails (module missing).

- [ ] **Step 3: Implement** — `src/git/token-git.ts`:

```ts
import { writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Git calls GIT_ASKPASS with the prompt as $1. Answer the username with the
// fixed PAT username and everything else (the password prompt) with the token
// from the env. The token is NEVER on a command line or in .git/config.
const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) printf '%s' "x-access-token" ;;
  *) printf '%s' "$TWEAKLET_GIT_TOKEN" ;;
esac
`;

let askpassPath: string | null = null;

/** Write (once) the askpass helper and return its path. */
export function ensureAskpass(): string {
  if (askpassPath && existsSync(askpassPath)) return askpassPath;
  const p = join(tmpdir(), "tweaklet-git-askpass.sh");
  writeFileSync(p, ASKPASS, { mode: 0o700 });
  chmodSync(p, 0o700);
  askpassPath = p;
  return p;
}

/** Env that makes git authenticate over HTTPS as `token` without persisting it. */
export function tokenGitEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_ASKPASS: ensureAskpass(),
    TWEAKLET_GIT_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
  };
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/git/token-git.test.ts` → pass.

- [ ] **Step 5: Commit** — `git add src/git/token-git.ts src/git/token-git.test.ts && git commit -m "feat(tweaklet): GIT_ASKPASS token-injection helper"`

---

### Task 3: `clone.ts` — token git clone, drop gh

**Files:** Modify `src/git/clone.ts`; Test `src/git/clone.test.ts`.

**Context:** keep `parseRepoRef` + `isRepoAllowed` unchanged. The `Exec` type gains an `env` param. Remove `ghRepoView`/`repoAccessible` (gh-based).

- [ ] **Step 1: Write failing test** — replace the clone tests that referenced `gh` (search `clone.test.ts` for `gh`); add:

```ts
import { describe, it, expect } from "vitest";
import { cloneAllowedRepo } from "./clone.js";
import { existsSync } from "node:fs";

describe("cloneAllowedRepo (token git)", () => {
  const allowlist = ["transcenda/t8a"];
  it("clones the https URL with the token env (no gh, token not on argv)", async () => {
    const calls: { cmd: string; args: string[]; hasToken: boolean }[] = [];
    const exec = async (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => {
      calls.push({ cmd, args, hasToken: env?.TWEAKLET_GIT_TOKEN === "tok" });
      return { code: 0, stdout: "", stderr: "" };
    };
    // target/.git absent → clone path
    await cloneAllowedRepo("transcenda/t8a", { allowlist, sourceDir: "/tmp/zzz-not-real", baseBranch: "main", token: "tok" }, exec);
    const clone = calls.find((c) => c.args[0] === "clone")!;
    expect(clone.cmd).toBe("git");
    expect(clone.args).toContain("https://github.com/transcenda/t8a");
    expect(clone.hasToken).toBe(true);
    expect(calls.every((c) => !c.args.join(" ").includes("tok"))).toBe(true); // token never on argv
    expect(calls.some((c) => c.cmd === "gh")).toBe(false);                    // gh dropped
  });

  it("rejects a repo not in the allowlist", async () => {
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(
      cloneAllowedRepo("evil/repo", { allowlist, sourceDir: "/tmp/zzz", baseBranch: "main", token: "tok" }, exec),
    ).rejects.toThrow(/allowlist/);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/git/clone.test.ts` → fails.

- [ ] **Step 3: Implement** — in `clone.ts`: change `Exec` and rewrite `cloneAllowedRepo`; delete `ghRepoView`, `repoAccessible`.

```ts
import { tokenGitEnv } from "./token-git.js";

// Exec now carries an optional env (for token injection).
type Exec = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<unknown>;
const pexec: Exec = (cmd, args, env) =>
  promisify(execFile)(cmd, args, { env: env ? { ...process.env, ...env } : process.env });

export async function cloneAllowedRepo(
  repoRef: string,
  opts: { allowlist: string[]; sourceDir: string; baseBranch: string; token: string },
  exec: Exec = pexec,
): Promise<string> {
  const parsed = parseRepoRef(repoRef);
  if (!parsed || !isRepoAllowed(repoRef, opts.allowlist)) {
    throw new Error(`Repo "${repoRef}" is not in the allowlist`);
  }
  mkdirSync(opts.sourceDir, { recursive: true });
  const target = join(opts.sourceDir, parsed.name);
  const url = `https://${parsed.host}/${parsed.owner}/${parsed.name}`;
  const env = tokenGitEnv(opts.token);

  if (existsSync(join(target, ".git"))) {
    await exec("git", ["-C", target, "fetch"], env);
    await exec("git", ["-C", target, "switch", "--", opts.baseBranch], env);
  } else {
    await exec("git", ["clone", "--", url, target], env);
    await exec("git", ["-C", target, "switch", "--", opts.baseBranch], env);
  }
  return target;
}
```

Delete the now-unused `ghRepoView` and `repoAccessible` functions and any `Exec` default that lacked env.

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/git/clone.test.ts` → pass.

- [ ] **Step 5: Commit** — `git add src/git/clone.ts src/git/clone.test.ts && git commit -m "feat(tweaklet): token git clone, drop gh from clone"`

---

### Task 4: `repo.ts` — per-user commit author

**Files:** Modify `src/git/repo.ts`; Test `src/git/repo.test.ts` (real-git integration tests).

**Context:** `checkpoint` and `restoreCommit` make commits; they must author as the signed-in user. `startBranch` only checks out (no author).

- [ ] **Step 1: Write failing test** — append to `repo.test.ts` (it already sets up a temp git repo; reuse its harness — see top of file for how `tmp`/`init` is done, mirror it):

```ts
it("checkpoint authors the commit as the given user", async () => {
  // (reuse the file's existing temp-repo setup helper to make `dir`)
  await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
  await require("node:fs").promises.writeFile(`${dir}/f.txt`, "hi");
  await checkpoint(dir, "msg", { name: "Alice A", email: "alice@x.com" });
  const out = await require("node:util").promisify(require("node:child_process").execFile)(
    "git", ["-C", dir, "log", "-1", "--format=%an <%ae>"]);
  expect(out.stdout.trim()).toBe("Alice A <alice@x.com>");
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/git/repo.test.ts` → fails (checkpoint signature has no author).

- [ ] **Step 3: Implement** — in `repo.ts`:

```ts
export interface CommitAuthor { name: string; email: string; }

export async function checkpoint(cwd: string, message: string, author: CommitAuthor): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message]);
}

export async function restoreCommit(cwd: string, branch: string, sha: string, author: CommitAuthor): Promise<void> {
  assertSafeRef(branch, "branch");
  assertSafeRef(sha, "sha");
  await git(cwd, ["checkout", branch]);
  await git(cwd, ["read-tree", "-u", "--reset", sha]);
  const subject = await git(cwd, ["log", "-1", "--format=%s", sha]);
  await git(cwd, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", `Restore to "${subject}"`]);
}
```

(`startBranch`, `discard`, `reject`, `branchState`, `previewCommit`, `exitPreview` unchanged.)

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/git/repo.test.ts` → pass. Fix any existing `checkpoint(...)`/`restoreCommit(...)` callers in that test file to pass an author `{ name: "T", email: "t@x" }`.

- [ ] **Step 5: Commit** — `git add src/git/repo.ts src/git/repo.test.ts && git commit -m "feat(tweaklet): per-user commit author in repo lifecycle"`

---

### Task 5: `pr.ts` — REST PR + token push, drop gh

**Files:** Modify `src/git/pr.ts`; Test `src/git/pr.test.ts`.

**Context:** `createDraftPr` pushes (token) then opens a PR via REST. `prStatus` reads via REST. owner/repo derived from the origin remote; `apiBaseUrl` + `token` passed by the caller.

- [ ] **Step 1: Write failing test** — rewrite `pr.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createDraftPr, repoSlugFromRemote } from "./pr.js";

describe("createDraftPr (REST + token)", () => {
  it("pushes with the token env then POSTs a draft PR via REST", async () => {
    const pushed: { hasToken: boolean }[] = [];
    const exec = async (cmd: string, args: string[], _cwd: string, env?: NodeJS.ProcessEnv) => {
      if (args[0] === "push") pushed.push({ hasToken: env?.TWEAKLET_GIT_TOKEN === "tok" });
      return { stdout: "", stderr: "", code: 0 };
    };
    let posted: any = null;
    const fetchImpl = (async (url: string, init: any) => {
      posted = { url, init };
      return { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/o/r/pull/1" }) } as Response;
    }) as typeof fetch;
    const url = await createDraftPr("/cwd",
      { branch: "tweaklet/x", title: "T", body: "B", base: "main", owner: "o", repo: "r", token: "tok", apiBaseUrl: "https://api.github.com" },
      exec, fetchImpl);
    expect(url).toBe("https://github.com/o/r/pull/1");
    expect(pushed[0].hasToken).toBe(true);
    expect(posted.url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(posted.init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(posted.init.body)).toMatchObject({ title: "T", head: "tweaklet/x", base: "main", draft: true });
  });
});

describe("repoSlugFromRemote", () => {
  it("parses owner/name from the origin https url", async () => {
    const exec = async () => ({ stdout: "https://github.com/transcenda/t8a\n", stderr: "", code: 0 });
    expect(await repoSlugFromRemote("/cwd", exec)).toEqual({ owner: "transcenda", name: "t8a" });
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/git/pr.test.ts` → fails.

- [ ] **Step 3: Implement** — rewrite `pr.ts` (keep `assertSafeRef`; `Exec` gains `env`):

```ts
import { execFile } from "node:child_process";
import { assertSafeRef } from "./validate.js";
import { parseRepoRef } from "./clone.js";
import { tokenGitEnv } from "./token-git.js";

export interface ExecResult { stdout: string; stderr: string; code: number; }
export type Exec = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<ExecResult>;
type FetchLike = typeof fetch;

const realExec: Exec = (cmd, args, cwd, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0 });
    });
  });

export async function repoSlugFromRemote(cwd: string, exec: Exec = realExec): Promise<{ owner: string; name: string }> {
  const r = await exec("git", ["-C", cwd, "remote", "get-url", "origin"], cwd);
  if (r.code !== 0) throw new Error(`no origin remote: ${r.stderr}`);
  const p = parseRepoRef(r.stdout.trim());
  if (!p) throw new Error(`cannot parse origin: ${r.stdout.trim()}`);
  return { owner: p.owner, name: p.name };
}

export async function createDraftPr(
  cwd: string,
  opts: { branch: string; title: string; body: string; base: string; owner: string; repo: string; token: string; apiBaseUrl: string },
  exec: Exec = realExec,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  assertSafeRef(opts.branch, "branch");
  assertSafeRef(opts.base, "base");
  const push = await exec("git", ["push", "-u", "origin", opts.branch], cwd, tokenGitEnv(opts.token));
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr}`);
  const res = await fetchImpl(`${opts.apiBaseUrl}/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: opts.title, head: opts.branch, base: opts.base, body: opts.body, draft: true }),
  });
  if (!res.ok) throw new Error(`create PR failed: ${res.status}`);
  const j = (await res.json()) as { html_url: string };
  return j.html_url;
}

export interface PrStatus { state: string; isDraft: boolean; url: string; reviews: { author: string; state: string; body: string }[]; }

export async function prStatus(
  cwd: string,
  opts: { branch: string; owner: string; repo: string; token: string; apiBaseUrl: string },
  fetchImpl: FetchLike = fetch,
): Promise<PrStatus> {
  assertSafeRef(opts.branch, "branch");
  const h = { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" };
  const list = await fetchImpl(`${opts.apiBaseUrl}/repos/${opts.owner}/${opts.repo}/pulls?head=${opts.owner}:${opts.branch}&state=all`, { headers: h });
  if (!list.ok) throw new Error(`list PRs failed: ${list.status}`);
  const prs = (await list.json()) as { number: number; state: string; draft: boolean; html_url: string }[];
  if (prs.length === 0) throw new Error("no PR for branch");
  const pr = prs[0];
  const rv = await fetchImpl(`${opts.apiBaseUrl}/repos/${opts.owner}/${opts.repo}/pulls/${pr.number}/reviews`, { headers: h });
  const reviews = rv.ok ? ((await rv.json()) as { user?: { login: string }; state: string; body?: string }[]).map((r) => ({ author: r.user?.login ?? "", state: r.state, body: r.body ?? "" })) : [];
  return { state: pr.state, isDraft: !!pr.draft, url: pr.html_url, reviews };
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/git/pr.test.ts` → pass.

- [ ] **Step 5: Commit** — `git add src/git/pr.ts src/git/pr.test.ts && git commit -m "feat(tweaklet): REST PR + token push, drop gh from pr"`

---

### Task 6: `doctor.ts` + `setup-state.ts` — drop gh-auth + git-identity

**Files:** Modify `src/doctor/doctor.ts`, `src/server/setup-state.ts`; Test `src/doctor/doctor.test.ts`, `src/server/setup-routes.test.ts`.

- [ ] **Step 1: Update tests first** — in `doctor.test.ts`: delete the four tests covering `github cli` (not installed / not signed in) and `git identity` (set / unset). Add:

```ts
it("no longer emits gh-auth or git-identity checks (auth is per-user OAuth now)", async () => {
  const checks = await runDiagnostics(base, { exec: execOk(), pathExists: () => true, home: "/home/u", probeAgent: probeOk });
  expect(checks.find((c) => c.name === "github cli")).toBeUndefined();
  expect(checks.find((c) => c.name === "git identity")).toBeUndefined();
  expect(checks.find((c) => c.name === "git")!.status).toBe("ok"); // the git binary check stays
});
```
In `setup-routes.test.ts`: remove the `{ name: "git identity", ... }` and `{ name: "github cli", ... }` entries from `sampleChecks` and `allOkChecks`.

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/doctor src/server/setup-routes.test.ts` → the new test fails (checks still present).

- [ ] **Step 3: Implement** — in `doctor.ts`: delete the entire `// 4. gh CLI` block and the `// 4b. git commit identity` block. Remove `pm.installCmd("gh")` references (only those two used it; `git` keeps `pm.installCmd("git")`). In `setup-state.ts`:

```ts
const depsOk =
  checkOk("node version") &&
  checkOk("git") &&
  checkOk("opencode");
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/doctor src/server/setup-routes.test.ts` → pass.

- [ ] **Step 5: Commit** — `git add src/doctor/doctor.ts src/doctor/doctor.test.ts src/server/setup-state.ts src/server/setup-routes.test.ts && git commit -m "feat(tweaklet): drop gh-auth + git-identity setup checks (per-user OAuth)"`

---

### Task 7: `server.ts` — capture token, thread into clone/commit/pr, `/agent/clone`, `/setup/repo` → allowlist

**Files:** Modify `src/server/server.ts`; Test `src/server/agent-routes.test.ts`, `src/server/setup-routes.test.ts`.

**Context:** Add an in-`createServer` token map keyed by login. Capture on callback, clear on logout. Add `currentToken(req)`. Thread `token`/`author` into the lifecycle calls and a new `POST /agent/clone`. Change `POST /setup/repo` to set the allowlist (no clone).

- [ ] **Step 1: Write failing tests** — in `agent-routes.test.ts` add a clone-route test; in `setup-routes.test.ts` change the repo test to assert allowlist-set (no clone). Clone route test:

```ts
it("POST /agent/clone clones the selected allowlisted repo with the user's token", async () => {
  let cloned: { repoRef: string; token: string } | null = null;
  const app = createServer(
    { ...config, repo: { path: "/x", sourceDir: "/tmp/src", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: ["transcenda/t8a"] } },
    {
      exchangeCodeForToken: async () => "gho_tok",
      fetchGithubUser: async () => ({ login: "alice", id: 7, name: "Alice", email: "a@x.com" }),
      cloneRepo: async (repoRef: string, opts: any) => { cloned = { repoRef, token: opts.token }; return "/tmp/src/t8a"; },
    },
  );
  // sign in first so a token is stored
  // (mirror this file's existing OAuth-callback helper to get a session cookie + populate the token map)
  const cookie = await signInAlice(app); // helper: drive /auth/login + /auth/callback like the existing tests
  const res = await request(app).post("/tweaklet/agent/clone").set("Cookie", cookie).send({ repoRef: "transcenda/t8a" }).expect(200);
  expect(cloned!.repoRef).toBe("transcenda/t8a");
  expect(cloned!.token).toBe("gho_tok");
  expect(res.body.path).toBe("/tmp/src/t8a");
});
```

> If `agent-routes.test.ts` has no existing callback helper, add `signInAlice(app)` that GETs `/tweaklet/auth/login` (capture `apz_oauth_state` cookie) then GETs `/tweaklet/auth/callback?code=c&state=<state>` with that cookie, and returns the `apz_session` cookie from the response. The injected `exchangeCodeForToken`/`fetchGithubUser` make it deterministic.

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/server/agent-routes.test.ts` → fails (`/agent/clone` 404).

- [ ] **Step 3: Implement** — in `server.ts` `createServer`:

```ts
// near `const sessions = new Map<...>()`:
const tokenStore = new Map<string, { token: string; name: string; email: string }>();
function currentToken(req: Request): { token: string; name: string; email: string } | null {
  const u = currentUser(req);
  return u ? tokenStore.get(u.login) ?? null : null;
}
```

In `/auth/callback`, after `const user = await fetchUser(...)` and the `isAllowed` check, before setting the cookie:

```ts
tokenStore.set(user.login, { token, name: user.name, email: user.email });
```

In `/auth/logout`:

```ts
const u = currentUser(req); if (u) tokenStore.delete(u.login);
```

Add the clone route (after the other `/agent/*` routes):

```ts
router.post("/agent/clone", authGate, async (req, res) => {
  if (!config.repo) { res.status(400).json({ error: "no repo configured" }); return; }
  const tok = currentToken(req);
  if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
  const repoRef = String(req.body?.repoRef ?? "");
  try {
    const sourceDir = config.repo.sourceDir ?? join(homedir(), ".tweaklet", "repos");
    const path = await doCloneRepo(repoRef, { allowlist: config.repo.allowlist ?? [], sourceDir, baseBranch: config.repo.baseBranch, token: tok.token });
    config.repo = { ...config.repo, path };
    doSaveConfig(config);
    res.json({ path });
  } catch (e) {
    const msg = String(e);
    res.status(msg.includes("allowlist") ? 400 : 500).json({ error: msg });
  }
});
```

Thread author into commit-making lifecycle routes — `/agent/checkpoint` and `/agent/restore`:

```ts
// checkpoint
const tok = currentToken(req); if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
await lc.checkpoint(config.repo!.path, message, { name: tok.name, email: tok.email });
// restore
const tok = currentToken(req); if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
await lc.restoreCommit(config.repo!.path, lastBranch ?? config.repo!.baseBranch, sha, { name: tok.name, email: tok.email });
```

Thread token + slug into `/agent/pr` (use `repoSlugFromRemote` + token + apiBaseUrl):

```ts
const tok = currentToken(req); if (!tok) { res.status(401).json({ error: "sign in again" }); return; }
const slug = await prLib.repoSlugFromRemote(config.repo!.path);
const apiBaseUrl = config.github?.apiBaseUrl ?? "https://api.github.com";
const url = await lc.createDraftPr(config.repo!.path, { branch, title, body, base: config.repo!.prTarget, owner: slug.owner, repo: slug.name, token: tok.token, apiBaseUrl });
```
…and `/agent/pr` GET → `lc.prStatus(config.repo!.path, { branch, owner: slug.owner, repo: slug.name, token: tok.token, apiBaseUrl })`.

Update the `lifecycle` deps default + `ServerDeps` types so `checkpoint`/`restoreCommit`/`createDraftPr`/`prStatus` match the new signatures (Tasks 4–5). Update `cloneRepo` dep type to the new `cloneAllowedRepo` signature.

Change `POST /setup/repo` to set the allowlist (operator), not clone:

```ts
router.post("/setup/repo", setupLockGuard, setupAuthGuard, async (req, res) => {
  const allowlist = req.body?.allowlist;
  if (!Array.isArray(allowlist) || allowlist.some((r) => typeof r !== "string")) {
    res.status(400).json({ error: "allowlist must be an array of repo refs" }); return;
  }
  const cfg = loadFresh();
  cfg.repo = { ...(cfg.repo ?? { path: "", baseBranch: "main", branchPrefix: "tweaklet/", prTarget: "main", allowlist: [] }), allowlist };
  doSaveConfig(cfg);
  const checks = await runDiag(loadFresh());
  res.json({ ...computeSetupState(loadFresh(), checks), checks, allowlist });
});
```

> `repo.path` is `min(1)` in the config schema. Since the operator may save an allowlist before any clone, change `repo.path` to optional in `config.ts` (`z.string().min(1).optional()`) and guard reads (`requireRepo` already 400s when `!config.repo`; also guard `!config.repo.path`). Add that to `requireRepo`:
> `if (!config.repo?.path) { res.status(409).json({ error: "no repo cloned yet" }); return false; }`

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/server` → pass. Update `setup-routes.test.ts` repo test to send `{ allowlist: ["transcenda/t8a"] }` and assert it's saved (no clone called).

- [ ] **Step 5: Commit** — `git add src/server/server.ts src/server/agent-routes.test.ts src/server/setup-routes.test.ts src/config/config.ts && git commit -m "feat(tweaklet): capture OAuth token; per-user clone/commit/PR; /setup/repo sets allowlist"`

---

### Task 8: web API client — allowlist setup + clone

**Files:** Modify `web/src/api.ts`; Test `web/src/api.test.ts`.

- [ ] **Step 1: Write failing test** — add to `api.test.ts`:

```ts
it("setupApi.repo posts an allowlist; api.clone posts a repoRef", async () => {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: any) => { calls.push({ url, body: init?.body && JSON.parse(init.body) }); return new Response(JSON.stringify({ path: "/p", steps: [], checks: [], allowlist: [], firstIncompleteStepId: null, completed: false }), { status: 200 }); }) as any;
  await setupApi.repo({ allowlist: ["o/r"] });
  await api.clone("o/r");
  expect(calls.find((c) => c.url.endsWith("/setup/repo"))!.body).toEqual({ allowlist: ["o/r"] });
  expect(calls.find((c) => c.url.endsWith("/agent/clone"))!.body).toEqual({ repoRef: "o/r" });
});
```

- [ ] **Step 2: Run, verify fail** — `npm --prefix web test -- api.test.ts` → fails.

- [ ] **Step 3: Implement** — in `api.ts`: change `setupApi.repo` signature + add `api.clone`:

```ts
// in setupApi:
repo: (body: { allowlist: string[] }) =>
  setupFetch<SetupStateResponse>(`${getBase()}/setup/repo`, { method: "POST", body: JSON.stringify(body) }),

// in api:
clone: (repoRef: string) => post<{ path: string }>(`${getBase()}/agent/clone`, { repoRef }),
```

- [ ] **Step 4: Run, verify pass** — `npm --prefix web test -- api.test.ts` → pass.

- [ ] **Step 5: Commit** — `git add web/src/api.ts web/src/api.test.ts && git commit -m "feat(tweaklet): web api — allowlist setup + clone"`

---

### Task 9: web wizard Repository step → allowlist editor; web Panel → repo pick + clone

**Files:** Modify `web/src/SetupWizard.tsx`, `web/src/Panel.tsx`; Test `web/src/SetupWizard.test.tsx`, `web/src/Panel.test.tsx`.

- [ ] **Step 1: Write failing tests** — `SetupWizard.test.tsx`: the Repository step renders an allowlist editor (textarea/inputs) and `Save` calls `setupApi.repo({ allowlist })`. `Panel.test.tsx`: when `agent.state` reports no cloned repo, the panel shows a repo picker from the allowlist and clicking a repo calls `api.clone(repoRef)`.

```tsx
// SetupWizard.test.tsx (sketch — mirror existing mock setup in the file)
it("Repository step saves an allowlist (no clone)", async () => {
  setupApiMock.state.mockResolvedValue(makeState({ firstIncompleteStepId: "repo", steps: [
    { id: "dependencies", label: "System dependencies", status: "done" },
    { id: "github", label: "GitHub OAuth", status: "done" },
    { id: "agent", label: "AI agent", status: "done" },
    { id: "repo", label: "Repository", status: "todo" },
  ], allowlist: [] }));
  setupApiMock.repo.mockResolvedValue(makeState({}));
  render(<App />);
  const input = await screen.findByLabelText(/allowed repositories/i);
  fireEvent.change(input, { target: { value: "transcenda/t8a" } });
  fireEvent.click(screen.getByRole("button", { name: /save repositories/i }));
  await waitFor(() => expect(setupApiMock.repo).toHaveBeenCalledWith({ allowlist: ["transcenda/t8a"] }));
});
```

- [ ] **Step 2: Run, verify fail** — `npm --prefix web test -- SetupWizard.test.tsx Panel.test.tsx` → fail.

- [ ] **Step 3: Implement** —
  - `SetupWizard.tsx` `RepoStep`: replace the clone dropdown with a textarea (one `owner/name` per line) bound to `allowlist`; `Save repositories` → `setupApi.repo({ allowlist })`. Label `Allowed repositories`. Keep the per-step `CheckList` for repo-category checks.
  - `Panel.tsx`: on mount, fetch `api.state()`. If it 409s / reports no cloned repo (`onFeature===undefined` is not reliable — instead, the clone state is "no repo": detect via a dedicated field), show a `RepoPicker` that lists `allowlist` (from `setupApi.state` is setup-only; instead expose the allowlist on `api.state` response, OR fetch it from a small authed `GET /agent/repos` returning `config.repo.allowlist`). Add `GET /agent/repos` → `{ allowlist, cloned: boolean }`; `api.repos()`; the picker calls `api.clone(ref)` then reloads.

  > Add to `server.ts`: `router.get("/agent/repos", authGate, (_req,res)=>res.json({ allowlist: config.repo?.allowlist ?? [], cloned: !!config.repo?.path }))` and `api.repos()` in `api.ts` (with a matching api.test assertion). This is the data source for the picker.

- [ ] **Step 4: Run, verify pass** — `npm --prefix web test` → pass.

- [ ] **Step 5: Commit** — `git add web/src/SetupWizard.tsx web/src/Panel.tsx web/src/api.ts web/src/*.test.tsx src/server/server.ts && git commit -m "feat(tweaklet): allowlist setup step + post-sign-in repo pick & clone"`

---

### Task 10: Docs + full gate + push

**Files:** `tweaklet/README.md`, `tweaklet/docs/INSTALL.md`.

- [ ] **Step 1** — Update README/INSTALL: setup no longer needs `gh auth login` or `git config`; instead the operator sets the OAuth App (with `repo read:user user:email` scopes) + the repo allowlist; end users sign in via the UI and pick a repo to clone. Remove stale gh/identity mentions.
- [ ] **Step 2** — Full gate: `npm run build && npm test` + `npm --prefix web run build && npm --prefix web test`. All green.
- [ ] **Step 3** — Commit docs: `git commit -am "docs(tweaklet): per-user OAuth auth — no gh/git-config setup"`.
- [ ] **Step 4** — Push the branch (one gate run) to update PR #85.

## Final verification (controller)
- Final review subagent (focus: token never persisted/logged/cookie'd; allowlist still enforced server-side in `clone.ts`; commit author = OAuth profile; PR via REST with the token; no `gh` references remain; `repo.path`-absent paths handled).
- Manual on nexus-dev: redeploy, walk the simplified wizard (no gh/identity items), sign in, pick `transcenda/t8a`, confirm clone + a tweak commit authored as the signed-in user + a PR opened as them.
