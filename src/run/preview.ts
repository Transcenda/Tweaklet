import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
export type Exec = (cmd: string, args: string[], opts: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
export interface PreviewConfig { serviceName: string; subdir: string; installCheckDir: string; }
export interface PreviewResult { started: boolean; installed: boolean; restarted: boolean; }

// Records which lockfile the installed node_modules came from, so a lockfile
// change (e.g. a fresh change cut from a newer main) triggers a reinstall.
const STAMP_FILE = ".tweaklet-lock";

let inFlight: Promise<unknown> = Promise.resolve();

/** Serialised: two overlapping calls (e.g. serve start + a switch) must never
 *  run two `npm ci` in the same directory. */
export function ensurePreview(...args: Parameters<typeof ensurePreviewNow>): Promise<PreviewResult> {
  const run = inFlight.then(() => ensurePreviewNow(...args), () => ensurePreviewNow(...args));
  inFlight = run.catch(() => {});
  return run;
}

/**
 * Make the live-preview dev server reflect the current clone, disrupting it as
 * little as possible:
 *  - (re)install deps when node_modules is missing or the lockfile changed
 *    since the last install, then restart the unit;
 *  - otherwise only restart the unit if it isn't running (e.g. after a reboot) —
 *    a running Vite picks up checked-out files itself via HMR.
 * Returns {started:false} when no preview is configured (host-agnostic no-op).
 * Errors propagate to the caller, which treats preview failure as non-fatal.
 */
async function ensurePreviewNow(
  repoPath: string,
  preview: PreviewConfig | undefined,
  deps: {
    exec?: Exec;
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string;
    writeFile?: (p: string, s: string) => void;
  } = {},
): Promise<PreviewResult> {
  if (!preview) return { started: false, installed: false, restarted: false };
  const exec = deps.exec ?? ((c, a, o) => pexec(c, a, o).then(r => ({ stdout: String(r.stdout), stderr: String(r.stderr) })));
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = deps.writeFile ?? ((p: string, s: string) => writeFileSync(p, s));
  const cwd = join(repoPath, preview.subdir);
  const lockPath = join(cwd, "package-lock.json");
  const stampPath = join(repoPath, preview.installCheckDir, STAMP_FILE);

  const lockHash = exists(lockPath) ? createHash("sha256").update(readFile(lockPath)).digest("hex") : null;
  const stamped = exists(stampPath) ? readFile(stampPath).trim() : null;
  const depsMissing = !exists(join(repoPath, preview.installCheckDir));
  const installed = depsMissing || (lockHash !== null && lockHash !== stamped);

  if (installed) {
    await exec("npm", ["ci", "--no-audit", "--no-fund"], { cwd });
    if (lockHash) writeFile(stampPath, lockHash);
  }

  let running = false;
  if (!installed) {
    try { await exec("systemctl", ["is-active", "--quiet", preview.serviceName], { cwd }); running = true; }
    catch { running = false; }
  }
  const restarted = installed || !running;
  // Sudoers grants the Tweaklet user exactly this restart (set up in dev infra).
  // -n: fail fast instead of hanging on a password prompt if sudoers drifts.
  if (restarted) await exec("sudo", ["-n", "systemctl", "restart", preview.serviceName], { cwd });
  return { started: true, installed, restarted };
}
