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
  const exec = deps.exec ?? ((c, a, o) => pexec(c, a, o).then(r => ({ stdout: String(r.stdout), stderr: String(r.stderr) })));
  const exists = deps.exists ?? existsSync;
  const cwd = join(repoPath, preview.subdir);
  if (!exists(join(repoPath, preview.installCheckDir))) {
    await exec("npm", ["ci"], { cwd });
  }
  // Sudoers grants the Tweaklet user exactly this restart (set up in dev infra).
  await exec("sudo", ["systemctl", "restart", preview.serviceName], { cwd });
  return { started: true };
}
