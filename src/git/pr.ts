import { execFile } from "node:child_process";
import { assertSafeRef } from "./validate.js";
import { parseRepoRef } from "../repo/clone.js";
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
