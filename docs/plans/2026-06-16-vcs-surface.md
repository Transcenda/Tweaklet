# Tweaklet VCS Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give non-technical Tweaklet users a legible, safe version-control surface in the panel — see the current branch, start/discard a single feature branch, browse a timeline of saved points with preview→confirm restore, and submit a draft PR.

**Architecture:** New git operations in `tweaklet/src/git/repo.ts` (real `git`, dependency-injected via the server's `lifecycle` deps), exposed through new Express routes in `tweaklet/src/server/server.ts`, called from `tweaklet/web/src/api.ts`, and rendered by `tweaklet/web/src/Panel.tsx` (a "where you are" bar + a History timeline + a preview banner). Restore is non-destructive (a new commit whose tree equals the target). Branch naming is developer-configured via `repo.branchPrefix`.

**Tech Stack:** Node/TypeScript ESM, Express, `@opencode-ai/sdk` (unrelated here), Vitest (backend + jsdom web), React + Vite. Tests use `supertest` for routes and a real temp git repo for `repo.ts`.

Spec: `tweaklet/docs/specs/2026-06-15-vcs-surface-design.md`. Run all commands from `tweaklet/` unless noted. Backend tests: `npm test`. Web tests: `npm --prefix web test`. Builds: `npm run build` and `npm --prefix web run build`.

---

## File Structure

- **Modify** `tweaklet/src/config/config.ts` — change `repo.branchPrefix` default `"sandbox/"` → `"tweaklet/"`.
- **Modify** `tweaklet/src/git/repo.ts` — `startBranch` drops the user segment; add `branchState`, `isDirty`, `previewCommit`, `exitPreview`, `restoreCommit`.
- **Modify** `tweaklet/src/git/repo.test.ts` — tests for the above (real temp git).
- **Modify** `tweaklet/src/server/server.ts` — extend the `lifecycle` deps (type + default), update the `/api/idea` call, add `GET /api/state`, `POST /api/preview`, `POST /api/preview/exit`, `POST /api/restore`, and a server-scoped `previewing` flag.
- **Modify** `tweaklet/src/server/lifecycle-routes.test.ts` — extend the stub + add route tests.
- **Modify** `tweaklet/web/src/api.ts` — add `state`, `preview`, `exitPreview`, `restore`; widen `startIdea` return is unchanged.
- **Modify** `tweaklet/web/src/Panel.tsx` — branch bar, History timeline, preview banner, composer-disable-while-previewing.
- **Modify** `tweaklet/web/src/Panel.test.tsx` — branch bar + history + preview tests.
- **Modify** `tweaklet/web/src/panel.css` — styles for the branch bar, history list, preview banner.
- **Modify** `tweaklet/README.md` — document `branchPrefix` as the setup-time branch convention.

---

## Task 1: Branch-naming convention (config default + drop user segment)

**Files:**
- Modify: `tweaklet/src/config/config.ts` (the `branchPrefix` default)
- Modify: `tweaklet/src/git/repo.ts:26-35` (`startBranch`)
- Test: `tweaklet/src/git/repo.test.ts`, `tweaklet/src/server/lifecycle-routes.test.ts`

- [ ] **Step 1: Update the failing test in `repo.test.ts`**

Replace the existing `startBranch` test body so it expects `prefix + slug` with **no** user segment:

```ts
  it("startBranch creates a prefixed branch from base (no user segment)", async () => {
    const branch = await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "Bigger box" });
    expect(branch).toBe("tweaklet/bigger-box");
    expect(await currentBranch(dir)).toBe("tweaklet/bigger-box");
  });
```

Also update the other `startBranch(...)` calls in this file (in the `checkpoint`, `discard`, `reject` tests) to drop `user` and use the new shape, e.g.:

```ts
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
```

- [ ] **Step 2: Run it — expect failure**

Run: `npm test -- src/git/repo.test.ts`
Expected: FAIL (`startBranch` still expects `user`; branch contains `alice-`).

- [ ] **Step 3: Implement — drop the user segment**

In `tweaklet/src/git/repo.ts` replace `startBranch`:

```ts
export async function startBranch(
  cwd: string,
  opts: { base: string; prefix: string; idea: string },
): Promise<string> {
  assertSafeRef(opts.base, "base");
  const branch = `${opts.prefix}${slugify(opts.idea)}`;
  await git(cwd, ["checkout", opts.base]);
  await git(cwd, ["checkout", "-B", branch]);
  return branch;
}
```

- [ ] **Step 4: Change the config default**

In `tweaklet/src/config/config.ts`, in the `repo` object schema, change:

```ts
      branchPrefix: z.string().default("tweaklet/"),
```

- [ ] **Step 5: Fix the route call + the lifecycle test stub**

In `tweaklet/src/server/server.ts`, the `/api/idea` handler — remove `user: user.login` from the `startBranch` call:

```ts
      const branch = await lc.startBranch(config.repo!.path, { base: config.repo!.baseBranch, prefix: config.repo!.branchPrefix, idea });
```
(Keep the `const user = currentUser(req)!;` line — it's still used for `sessions.delete(user.login)`.)

In `tweaklet/src/server/lifecycle-routes.test.ts` update the stub + the convention assertion:

```ts
  startBranch: async (_cwd: string, o: any) => `tweaklet/${o.idea.toLowerCase().replace(/\W+/g, "-")}`,
```
```ts
  it("POST /api/idea starts a branch named per convention", async () => {
    const res = await request(app()).post("/api/idea").set("Cookie", cookie).send({ idea: "Bigger" }).expect(200);
    expect(res.body.branch).toBe("tweaklet/bigger");
  });
```

- [ ] **Step 6: Run all backend tests + commit**

Run: `npm test`
Expected: PASS (118 → same count).

```bash
git add tweaklet/src/config/config.ts tweaklet/src/git/repo.ts tweaklet/src/git/repo.test.ts tweaklet/src/server/server.ts tweaklet/src/server/lifecycle-routes.test.ts
git commit -m "feat(tweaklet): branch naming = configurable prefix + request slug (drop user segment)"
```

---

## Task 2: `branchState` git op + `GET /api/state`

**Files:**
- Modify: `tweaklet/src/git/repo.ts` (add `branchState`)
- Modify: `tweaklet/src/server/server.ts` (add `previewing` flag, `GET /api/state`, deps)
- Modify: `tweaklet/web/src/api.ts` (add `state`)
- Test: `tweaklet/src/git/repo.test.ts`, `tweaklet/src/server/lifecycle-routes.test.ts`

- [ ] **Step 1: Failing test for `branchState` (`repo.test.ts`)**

```ts
  it("branchState lists only this branch's commits since base, newest first", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    writeFileSync(join(dir, "a.txt"), "1\n"); await checkpoint(dir, "first");
    writeFileSync(join(dir, "a.txt"), "2\n"); await checkpoint(dir, "second");
    const st = await branchState(dir, "main");
    expect(st.onFeature).toBe(true);
    expect(st.branch).toBe("tweaklet/x");
    expect(st.commits.map((c) => c.message)).toEqual(["second", "first"]); // newest first
    expect(st.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("branchState on base reports no feature branch and no commits", async () => {
    const st = await branchState(dir, "main");
    expect(st.onFeature).toBe(false);
    expect(st.commits).toEqual([]);
  });
```

Add `branchState` to the import at the top of `repo.test.ts`.

- [ ] **Step 2: Run it — expect failure**

Run: `npm test -- src/git/repo.test.ts`
Expected: FAIL (`branchState` is not defined).

- [ ] **Step 3: Implement `branchState` in `repo.ts`**

```ts
export interface SavedPoint { sha: string; message: string; relativeTime: string; }
export interface BranchState { branch: string; base: string; onFeature: boolean; commits: SavedPoint[]; }

export async function branchState(cwd: string, base: string): Promise<BranchState> {
  assertSafeRef(base, "base");
  const branch = await currentBranch(cwd);
  const onFeature = branch !== base;
  let commits: SavedPoint[] = [];
  if (onFeature) {
    // %x1f = unit separator; one line per commit, newest first (default log order).
    const out = await git(cwd, ["log", `${base}..HEAD`, "--format=%H%x1f%s%x1f%cr"]);
    commits = out
      ? out.split("\n").map((line) => {
          const [sha, message, relativeTime] = line.split("\x1f");
          return { sha, message, relativeTime };
        })
      : [];
  }
  return { branch, base, onFeature, commits };
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npm test -- src/git/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `previewing` flag, deps wiring, and `GET /api/state`**

In `tweaklet/src/server/server.ts`:

(a) Extend the `lifecycle` deps **type** (in `ServerDeps`) — add after `prStatus`:
```ts
    branchState: typeof repoLib.branchState;
```
(b) Extend the `lc` default object — add:
```ts
    branchState: repoLib.branchState,
```
(c) Inside `createServer`, near the other `let` state (e.g. by `let currentAbort`), add:
```ts
  let previewing: string | null = null; // sha currently previewed, or null
```
(d) Add the route (place it next to the other lifecycle routes, e.g. after `GET /api/pr`):
```ts
  app.get("/api/state", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      const st = await lc.branchState(config.repo!.path, config.repo!.baseBranch);
      res.json({ ...st, previewing });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
```

- [ ] **Step 6: Add `api.state()` in `web/src/api.ts`**

Add to the `api` object (after `prStatus`):
```ts
  state: () => get<{ branch: string; base: string; onFeature: boolean; commits: { sha: string; message: string; relativeTime: string }[]; previewing: string | null }>("/api/state"),
```

- [ ] **Step 7: Route test in `lifecycle-routes.test.ts`**

Add `branchState` to the stub object:
```ts
  branchState: async () => ({ branch: "tweaklet/x", base: "main", onFeature: true, commits: [{ sha: "a".repeat(40), message: "first", relativeTime: "1 min ago" }] }),
```
Add a test:
```ts
  it("GET /api/state returns branch + commits + previewing", async () => {
    const res = await request(app()).get("/api/state").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ branch: "tweaklet/x", onFeature: true, previewing: null });
    expect(res.body.commits).toHaveLength(1);
  });
```
Also add `["get", "/api/state"]` to the auth-required loop.

- [ ] **Step 8: Run backend tests + commit**

Run: `npm test`
Expected: PASS.

```bash
git add tweaklet/src/git/repo.ts tweaklet/src/git/repo.test.ts tweaklet/src/server/server.ts tweaklet/src/server/lifecycle-routes.test.ts tweaklet/web/src/api.ts
git commit -m "feat(tweaklet): branchState op + GET /api/state (branch + saved-points timeline)"
```

---

## Task 3: Preview / exit-preview / restore git ops + routes

**Files:**
- Modify: `tweaklet/src/git/repo.ts` (`isDirty`, `previewCommit`, `exitPreview`, `restoreCommit`)
- Modify: `tweaklet/src/server/server.ts` (3 routes + deps)
- Modify: `tweaklet/web/src/api.ts` (`preview`, `exitPreview`, `restore`)
- Test: `tweaklet/src/git/repo.test.ts`, `tweaklet/src/server/lifecycle-routes.test.ts`

- [ ] **Step 1: Failing tests in `repo.test.ts`**

```ts
  it("previewCommit shows an older tree, exitPreview returns to the tip", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    writeFileSync(join(dir, "a.txt"), "one\n"); await checkpoint(dir, "first");
    const first = (await branchState(dir, "main")).commits[0].sha;
    writeFileSync(join(dir, "a.txt"), "two\n"); await checkpoint(dir, "second");

    await previewCommit(dir, first);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n"); // older state visible

    await exitPreview(dir, "tweaklet/x");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two\n"); // back to tip
    expect(await currentBranch(dir)).toBe("tweaklet/x");
  });

  it("restoreCommit makes a new tip whose tree equals the target; nothing is lost", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    writeFileSync(join(dir, "a.txt"), "one\n"); await checkpoint(dir, "first");
    const first = (await branchState(dir, "main")).commits[0].sha;
    writeFileSync(join(dir, "a.txt"), "two\n"); writeFileSync(join(dir, "b.txt"), "added\n"); await checkpoint(dir, "second");

    await restoreCommit(dir, "tweaklet/x", first);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n"); // tree matches "first"
    expect(existsSync(join(dir, "b.txt"))).toBe(false);            // b.txt (added in "second") is gone
    const msgs = (await branchState(dir, "main")).commits.map((c) => c.message);
    expect(msgs).toContain("first");
    expect(msgs).toContain("second");                              // history preserved
    expect(msgs.length).toBe(3);                                   // first, second, + the restore
  });

  it("isDirty reflects uncommitted changes", async () => {
    await startBranch(dir, { base: "main", prefix: "tweaklet/", idea: "x" });
    expect(await isDirty(dir)).toBe(false);
    writeFileSync(join(dir, "a.txt"), "x\n");
    expect(await isDirty(dir)).toBe(true);
  });
```

Add `readFileSync` + `existsSync` to the `node:fs` import, and `previewCommit, exitPreview, restoreCommit, isDirty` to the `./repo.js` import.

- [ ] **Step 2: Run them — expect failure**

Run: `npm test -- src/git/repo.test.ts`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Implement in `repo.ts`**

```ts
export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])).length > 0;
}

/** Show an older commit's exact tree in the working dir (detached HEAD), without
 *  moving the branch. Requires a clean tree (caller enforces "Save first"). */
export async function previewCommit(cwd: string, sha: string): Promise<void> {
  assertSafeRef(sha, "sha");
  await git(cwd, ["checkout", sha]);
}

/** Leave preview: re-attach to the branch tip. */
export async function exitPreview(cwd: string, branch: string): Promise<void> {
  assertSafeRef(branch, "branch");
  await git(cwd, ["checkout", branch]);
}

/** Non-destructive restore: add a NEW commit on `branch` whose tree equals `sha`.
 *  read-tree -u --reset sets index + working tree to sha's tree (removing files
 *  not present in sha) without moving HEAD; the commit then records it on the
 *  branch tip, preserving all existing history. */
export async function restoreCommit(cwd: string, branch: string, sha: string): Promise<void> {
  assertSafeRef(branch, "branch");
  assertSafeRef(sha, "sha");
  await git(cwd, ["checkout", branch]);
  await git(cwd, ["read-tree", "-u", "--reset", sha]);
  const subject = await git(cwd, ["log", "-1", "--format=%s", sha]);
  await git(cwd, ["commit", "-m", `Restore to "${subject}"`]);
}
```

- [ ] **Step 4: Run them — expect pass**

Run: `npm test -- src/git/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Add deps + routes in `server.ts`**

(a) `ServerDeps.lifecycle` type — add:
```ts
    isDirty: typeof repoLib.isDirty;
    previewCommit: typeof repoLib.previewCommit;
    exitPreview: typeof repoLib.exitPreview;
    restoreCommit: typeof repoLib.restoreCommit;
```
(b) `lc` default — add:
```ts
    isDirty: repoLib.isDirty,
    previewCommit: repoLib.previewCommit,
    exitPreview: repoLib.exitPreview,
    restoreCommit: repoLib.restoreCommit,
```
(c) Routes (next to `GET /api/state`):
```ts
  app.post("/api/preview", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const sha = String(req.body?.sha ?? "");
    if (!sha) { res.status(400).json({ error: "no sha" }); return; }
    try {
      if (await lc.isDirty(config.repo!.path)) {
        res.status(409).json({ error: "unsaved changes", detail: "Save your current changes before previewing." });
        return;
      }
      await lc.previewCommit(config.repo!.path, sha);
      previewing = sha;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post("/api/preview/exit", authGate, async (_req, res) => {
    if (!requireRepo(res)) return;
    try {
      const st = await lc.branchState(config.repo!.path, config.repo!.baseBranch);
      // While previewing, HEAD is detached; branchState's `branch` would be a sha.
      // Re-attach using the configured base only as a fallback; prefer the last branch.
      await lc.exitPreview(config.repo!.path, lastBranch ?? st.branch);
      previewing = null;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post("/api/restore", authGate, async (req, res) => {
    if (!requireRepo(res)) return;
    const sha = String(req.body?.sha ?? "");
    if (!sha) { res.status(400).json({ error: "no sha" }); return; }
    try {
      await lc.restoreCommit(config.repo!.path, lastBranch ?? config.repo!.baseBranch, sha);
      previewing = null;
      res.status(204).end();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
```
(d) Track the branch we entered preview from. Add near `let previewing`:
```ts
  let lastBranch: string | null = null;
```
and in the `/api/preview` handler, before calling `previewCommit`, capture it:
```ts
      lastBranch = (await lc.branchState(config.repo!.path, config.repo!.baseBranch)).branch;
```
(place this line immediately after the `isDirty` guard, before `previewCommit`).

- [ ] **Step 6: `api.ts` methods**

Add to the `api` object:
```ts
  preview: (sha: string) => post<void>("/api/preview", { sha }),
  exitPreview: () => post<void>("/api/preview/exit"),
  restore: (sha: string) => post<void>("/api/restore", { sha }),
```

- [ ] **Step 7: Route tests in `lifecycle-routes.test.ts`**

Add to the stub:
```ts
  isDirty: async () => false,
  previewCommit: async () => {},
  exitPreview: async () => {},
  restoreCommit: async () => {},
```
Tests:
```ts
  it("POST /api/preview previews a sha (204) and blocks when dirty (409)", async () => {
    await request(app()).post("/api/preview").set("Cookie", cookie).send({ sha: "a".repeat(40) }).expect(204);
    await request(app({ isDirty: async () => true })).post("/api/preview").set("Cookie", cookie).send({ sha: "a".repeat(40) }).expect(409);
  });
  it("POST /api/preview/exit and /api/restore return 204", async () => {
    await request(app()).post("/api/preview/exit").set("Cookie", cookie).send().expect(204);
    await request(app()).post("/api/restore").set("Cookie", cookie).send({ sha: "a".repeat(40) }).expect(204);
  });
```

- [ ] **Step 8: Run backend tests + build + commit**

Run: `npm test` then `npm run build`
Expected: PASS + clean build.

```bash
git add tweaklet/src/git/repo.ts tweaklet/src/git/repo.test.ts tweaklet/src/server/server.ts tweaklet/src/server/lifecycle-routes.test.ts tweaklet/web/src/api.ts
git commit -m "feat(tweaklet): preview/exit/restore git ops + routes (non-destructive history nav)"
```

---

## Task 4: Panel "where you are" bar

**Files:**
- Modify: `tweaklet/web/src/Panel.tsx`
- Modify: `tweaklet/web/src/panel.css`
- Test: `tweaklet/web/src/Panel.test.tsx`

- [ ] **Step 1: Failing test in `Panel.test.tsx`**

Add `state` to the `apiMock` (in the `vi.hoisted` block, after `reject`):
```ts
    state: vi.fn(),
```
In `beforeEach`, give it a default:
```ts
  apiMock.state.mockResolvedValue({ branch: "main", base: "main", onFeature: false, commits: [], previewing: null });
```
Add the tests:
```ts
  it("on main, shows the branch and a Start a change action", async () => {
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    expect(await screen.findByText(/you're viewing the live app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start a change/i })).toBeInTheDocument();
  });

  it("on a feature branch, shows the branch name + Discard + History", async () => {
    apiMock.state.mockResolvedValue({ branch: "tweaklet/bigger", base: "main", onFeature: true, commits: [], previewing: null });
    render(<Panel />);
    expect(await screen.findByText(/tweaklet\/bigger/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /discard/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `npm --prefix web test -- Panel.test.tsx`
Expected: FAIL (no branch text / Start a change / History).

- [ ] **Step 3: Implement the bar in `Panel.tsx`**

(a) Add state + a loader. Near the other `useState`s:
```ts
  const [vcs, setVcs] = useState<Awaited<ReturnType<typeof api.state>> | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const refreshState = () => api.state().then(setVcs).catch(() => {});
```
Add an effect after the doctor effect:
```ts
  useEffect(() => { if (user) refreshState(); }, [user]);
```
(b) Call `refreshState()` after each lifecycle action so the bar/timeline stay current. In `ctl(...)`'s success path, after `push({ kind: "note", ... })`, add `void refreshState();` — simplest: change `ctl` to call `refreshState()` in its `finally`:
```ts
    finally { setBusy(false); void refreshState(); }
```
Also call `void refreshState();` at the end of `send()`'s `finally` and inside `rejectChanges()` after success.

(c) Render the bar as the first child inside `<div className="apz-flow">`, replacing nothing else (it sits above the existing steps). Insert at the top of the returned `.apz` (before `.apz-flow`), a new element:
```tsx
      <div className="apz-bar">
        {vcs?.onFeature ? (
          <>
            <span className="apz-branch"><span className="apz-branch-dot" />{vcs.branch}</span>
            <div className="apz-bar-actions">
              <button type="button" className="apz-bar-btn" onClick={() => setHistoryOpen((o) => !o)}>History</button>
              <button type="button" className="apz-reject" disabled={busy} onClick={rejectChanges}>Discard</button>
            </div>
          </>
        ) : (
          <>
            <span className="apz-branch apz-branch--main">{vcs?.branch ?? "main"} · you're viewing the live app</span>
            <button type="button" className="apz-bar-btn apz-bar-btn--primary" disabled={busy} onClick={() => goStage(0)}>Start a change</button>
          </>
        )}
      </div>
```
(The existing `Reject` button inside `apz-flow-tools` is now redundant with `Discard` in the bar — remove the `{started && (<button … apz-reject …>Reject</button>)}` block from `apz-flow-tools` to avoid two discard buttons.)

- [ ] **Step 4: Styles in `panel.css`**

Add:
```css
.apz-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 14px; border-bottom: 1px solid var(--line); background: var(--surface);
}
.apz-branch { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ink); font-weight: 600; }
.apz-branch--main { color: var(--ink-2); font-weight: 400; }
.apz-branch-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.apz-bar-actions { display: flex; gap: 6px; }
.apz-bar-btn {
  font-size: 11px; color: var(--ink-2); cursor: pointer; background: var(--surface);
  border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px;
  transition: border-color .15s, color .15s, background .15s;
}
.apz-bar-btn:hover:not(:disabled) { border-color: var(--line-2); color: var(--ink); }
.apz-bar-btn:disabled { opacity: .45; cursor: default; }
.apz-bar-btn--primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.apz-bar-btn--primary:hover:not(:disabled) { background: var(--accent-d); }
```

- [ ] **Step 5: Run web tests + commit**

Run: `npm --prefix web test -- Panel.test.tsx` then `npm --prefix web run build`
Expected: PASS + clean build.

```bash
git add tweaklet/web/src/Panel.tsx tweaklet/web/src/panel.css tweaklet/web/src/Panel.test.tsx
git commit -m "feat(tweaklet/web): 'where you are' branch bar (main vs feature branch)"
```

---

## Task 5: History timeline + preview banner

**Files:**
- Modify: `tweaklet/web/src/Panel.tsx`
- Modify: `tweaklet/web/src/panel.css`
- Test: `tweaklet/web/src/Panel.test.tsx`

- [ ] **Step 1: Failing tests in `Panel.test.tsx`**

```ts
  it("History lists saved points and Preview calls api.preview", async () => {
    apiMock.state.mockResolvedValue({ branch: "tweaklet/x", base: "main", onFeature: true, previewing: null,
      commits: [{ sha: "s2".padEnd(40, "0"), message: "second", relativeTime: "1 min ago" },
                { sha: "s1".padEnd(40, "0"), message: "first", relativeTime: "5 min ago" }] });
    apiMock.preview.mockResolvedValue(undefined);
    render(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: /history/i }));
    expect(await screen.findByText(/second/)).toBeInTheDocument();
    // newest ("second") is current → only older ("first") gets a Preview button
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(apiMock.preview).toHaveBeenCalledWith("s1".padEnd(40, "0")));
  });

  it("while previewing, shows a banner and Restore calls api.restore", async () => {
    apiMock.state.mockResolvedValue({ branch: "tweaklet/x", base: "main", onFeature: true,
      previewing: "s1".padEnd(40, "0"),
      commits: [{ sha: "s1".padEnd(40, "0"), message: "first", relativeTime: "5 min ago" }] });
    apiMock.restore.mockResolvedValue(undefined);
    render(<Panel />);
    expect(await screen.findByText(/previewing/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe a change/i)).toBeDisabled(); // composer locked
    fireEvent.click(screen.getByRole("button", { name: /restore here/i }));
    await waitFor(() => expect(apiMock.restore).toHaveBeenCalledWith("s1".padEnd(40, "0")));
  });
```
Add `preview`, `exitPreview`, `restore` to `apiMock` (hoisted block) + defaults in `beforeEach`:
```ts
    preview: vi.fn(), exitPreview: vi.fn(), restore: vi.fn(),
```
```ts
  apiMock.preview.mockResolvedValue(undefined); apiMock.exitPreview.mockResolvedValue(undefined); apiMock.restore.mockResolvedValue(undefined);
```

- [ ] **Step 2: Run — expect failure**

Run: `npm --prefix web test -- Panel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the history + banner in `Panel.tsx`**

(a) Derive previewing + handlers:
```ts
  const previewing = vcs?.previewing ?? null;
  async function preview(sha: string) { await ctl(() => api.preview(sha), "👁 previewing an earlier save"); }
  async function restoreHere() { if (!previewing) return; await ctl(() => api.restore(previewing!), "✓ restored"); setHistoryOpen(false); }
  async function backToLatest() { await ctl(() => api.exitPreview(), "↩ back to latest"); }
```
(b) Render the banner (when `previewing`) just above `.apz-stream`:
```tsx
      {previewing && (
        <div className="apz-preview-banner">
          <span>👁 Previewing an earlier save</span>
          <div className="apz-preview-actions">
            <button type="button" className="apz-bar-btn--primary apz-bar-btn" disabled={busy} onClick={restoreHere}>Restore here</button>
            <button type="button" className="apz-bar-btn" disabled={busy} onClick={backToLatest}>Back to latest</button>
          </div>
        </div>
      )}
```
(c) Render the history list (when `historyOpen && vcs?.onFeature`) below the bar:
```tsx
      {historyOpen && vcs?.onFeature && (
        <div className="apz-history">
          {vcs.commits.length === 0 ? (
            <div className="apz-history-empty">No saved points yet — use Save to create one.</div>
          ) : vcs.commits.map((c, i) => (
            <div key={c.sha} className={"apz-saved" + (i === 0 && !previewing ? " is-current" : "")}>
              <span className="apz-saved-dot" />
              <span className="apz-saved-msg">{c.message}</span>
              <span className="apz-saved-time">{c.relativeTime}</span>
              {!(i === 0 && !previewing) && (
                <button type="button" className="apz-bar-btn" disabled={busy} onClick={() => preview(c.sha)}>Preview</button>
              )}
            </div>
          ))}
        </div>
      )}
```
(d) Lock the composer while previewing — on the `<textarea>` add `disabled={busy || !!previewing}` (it currently is `disabled={busy}`), and on the send button likewise.

- [ ] **Step 4: Styles in `panel.css`**

```css
.apz-history { border-bottom: 1px solid var(--line); background: var(--surface-2); max-height: 220px; overflow: auto; }
.apz-history-empty { padding: 12px 14px; font-size: 12px; color: var(--muted); }
.apz-saved { display: flex; align-items: center; gap: 9px; padding: 8px 14px; font-size: 12px; }
.apz-saved + .apz-saved { border-top: 1px solid var(--line); }
.apz-saved-dot { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--line-2); background: var(--surface); flex: none; }
.apz-saved.is-current .apz-saved-dot { background: var(--accent); border-color: var(--accent); }
.apz-saved-msg { flex: 1; color: var(--ink); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apz-saved-time { color: var(--muted); flex: none; }
.apz-preview-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 14px; background: var(--accent-tint);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); font-size: 12px; color: var(--ink);
}
.apz-preview-actions { display: flex; gap: 6px; }
```

- [ ] **Step 5: Run web tests + build + commit**

Run: `npm --prefix web test` then `npm --prefix web run build`
Expected: PASS (all web tests) + clean build.

```bash
git add tweaklet/web/src/Panel.tsx tweaklet/web/src/panel.css tweaklet/web/src/Panel.test.tsx
git commit -m "feat(tweaklet/web): saved-points History timeline + preview→restore banner"
```

---

## Task 6: Document the branch convention + full verification

**Files:**
- Modify: `tweaklet/README.md`

- [ ] **Step 1: Add a setup note to `README.md`**

Under the "Local development" section (or a new "## Configuration" subsection), add:
```markdown
### Branch naming (developer setup)

Tweaklet creates one feature branch per change, named from a convention you
control in `~/.tweaklet/config.json`:

    "repo": { "branchPrefix": "tweaklet/", ... }

Branches are `<branchPrefix><slug-of-request>` (e.g. `tweaklet/make-header-bigger`).
Set `branchPrefix` to match your team's convention (`tweaklet/`, `feature/`,
`proposals/`, …). Non-technical users never name or pick branches.
```

- [ ] **Step 2: Full local verification**

Run, from `tweaklet/`:
```bash
npm run build && npm test
npm --prefix web run build && npm --prefix web test
```
Expected: both builds clean; all backend + web tests PASS.

- [ ] **Step 3: Restart the server + smoke-test the panel**

```bash
pkill -f "dist/index.js serve" || true
( cd /Users/joseph/Projects/transcenda/t8a && PATH=/opt/homebrew/Cellar/node/25.9.0_2/bin:$PATH node tweaklet/dist/index.js serve & )
```
Then via Playwright: visit `http://localhost:4319/auth/cli`, confirm the bar shows `main · you're viewing the live app` + "Start a change"; no console errors.

- [ ] **Step 4: Commit**

```bash
git add tweaklet/README.md
git commit -m "docs(tweaklet): document branchPrefix branch-naming convention"
```

---

## Self-Review notes (for the implementer)
- The `previewing` + `lastBranch` server state is in-memory and single-user — consistent with the existing `sessions`/`currentAbort` model. Fine for the single-instance design.
- `restoreCommit` uses `read-tree -u --reset` so files added after the target are removed and the new commit's tree exactly equals the target — verified by the `b.txt` assertion in Task 3.
- `previewCommit` requires a clean tree; the `/api/preview` route enforces it with `isDirty` (409). The panel surfaces the 409 as the "Save first" nudge (the `ctl` error path shows the server message).
