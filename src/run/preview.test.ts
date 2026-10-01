import { describe, it, expect, vi } from "vitest";
import { ensurePreview } from "./preview.js";

const PREVIEW = { serviceName: "t8a-frontend-dev", subdir: "frontend", installCheckDir: "frontend/node_modules" };
const LOCK = "/repo/frontend/package-lock.json";
const STAMP = "/repo/frontend/node_modules/.tweaklet-lock";

/** In-memory fs double: `files` maps path → contents; dirs exist when listed. */
function fs(files: Record<string, string>, dirs: string[] = []) {
  return {
    exists: (p: string) => p in files || dirs.includes(p),
    readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
    writeFile: vi.fn((p: string, s: string) => { files[p] = s; }),
  };
}
const ok = () => vi.fn(async (_cmd: string, _args: string[], _o: { cwd?: string }) => ({ stdout: "", stderr: "" }));
const restart = ["sudo", ["-n", "systemctl", "restart", "t8a-frontend-dev"], expect.anything()] as const;

describe("ensurePreview", () => {
  it("no-op when preview is undefined", async () => {
    const exec = vi.fn();
    const r = await ensurePreview("/repo", undefined, { exec, ...fs({}) });
    expect(r.started).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("installs deps when node_modules is missing, stamps the lockfile, then restarts", async () => {
    const exec = ok();
    const f = fs({ [LOCK]: "lock-v1" });
    const r = await ensurePreview("/repo", PREVIEW, { exec, ...f });
    expect(exec).toHaveBeenCalledWith("npm", ["ci", "--no-audit", "--no-fund"], expect.objectContaining({ cwd: "/repo/frontend" }));
    expect(exec).toHaveBeenCalledWith(...restart);
    expect(f.writeFile).toHaveBeenCalledWith(STAMP, expect.any(String));
    expect(r).toMatchObject({ started: true, installed: true, restarted: true });
  });

  it("reinstalls when the lockfile changed since the last install (e.g. after pulling main)", async () => {
    const exec = ok();
    const f = fs({ [LOCK]: "lock-v2", [STAMP]: "hash-of-v1" }, ["/repo/frontend/node_modules"]);
    const r = await ensurePreview("/repo", PREVIEW, { exec, ...f });
    expect(exec).toHaveBeenCalledWith("npm", ["ci", "--no-audit", "--no-fund"], expect.anything());
    expect(exec).toHaveBeenCalledWith(...restart);
    expect(r.installed).toBe(true);
  });

  it("does nothing disruptive when deps are current and the unit is running (Vite HMR handles file changes)", async () => {
    const first = fs({ [LOCK]: "lock-v1" });
    await ensurePreview("/repo", PREVIEW, { exec: ok(), ...first }); // stamps
    const exec = ok(); // `systemctl is-active` succeeds → running
    const f = fs({ [LOCK]: "lock-v1", [STAMP]: first.readFile(STAMP) }, ["/repo/frontend/node_modules"]);
    const r = await ensurePreview("/repo", PREVIEW, { exec, ...f });
    expect(exec).toHaveBeenCalledWith("systemctl", ["is-active", "--quiet", "t8a-frontend-dev"], expect.anything());
    expect(exec).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
    expect(exec).not.toHaveBeenCalledWith(...restart);
    expect(r).toMatchObject({ started: true, installed: false, restarted: false });
  });

  it("restarts a stopped unit even when deps are current (e.g. after a VM reboot)", async () => {
    const first = fs({ [LOCK]: "lock-v1" });
    await ensurePreview("/repo", PREVIEW, { exec: ok(), ...first });
    const exec = vi.fn(async (cmd: string, _args: string[], _o: { cwd?: string }) => {
      if (cmd === "systemctl") throw new Error("inactive");
      return { stdout: "", stderr: "" };
    });
    const f = fs({ [LOCK]: "lock-v1", [STAMP]: first.readFile(STAMP) }, ["/repo/frontend/node_modules"]);
    const r = await ensurePreview("/repo", PREVIEW, { exec, ...f });
    expect(exec).toHaveBeenCalledWith(...restart);
    expect(r).toMatchObject({ installed: false, restarted: true });
  });

  it("without a lockfile, only a missing node_modules triggers an install", async () => {
    const exec = ok();
    const r = await ensurePreview("/repo", PREVIEW, { exec, ...fs({}, ["/repo/frontend/node_modules"]) });
    expect(exec).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
    expect(r.installed).toBe(false);
  });

  it("serialises overlapping calls so two installs never run at once", async () => {
    let active = 0, maxActive = 0;
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === "npm") { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; }
      return { stdout: "", stderr: "" };
    });
    await Promise.all([
      ensurePreview("/repo", PREVIEW, { exec, ...fs({ [LOCK]: "a" }) }),
      ensurePreview("/repo", PREVIEW, { exec, ...fs({ [LOCK]: "b" }) }),
    ]);
    expect(exec.mock.calls.filter((c) => c[0] === "npm")).toHaveLength(2);
    expect(maxActive).toBe(1);
  });
});
