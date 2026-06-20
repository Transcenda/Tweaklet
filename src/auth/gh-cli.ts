import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GithubUser } from "./github-oauth.js";

const pexec = promisify(execFile);
export type GhExec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

export async function ghCliUser(exec: GhExec = (c, a) => pexec(c, a)): Promise<GithubUser | null> {
  try {
    const { stdout } = await exec("gh", ["api", "user"]);
    const u = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof u.login === "string" && typeof u.id === "number") {
      return { ...(u as object), login: u.login, id: u.id } as GithubUser;
    }
    return null;
  } catch {
    return null;
  }
}
