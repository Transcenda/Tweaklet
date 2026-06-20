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
