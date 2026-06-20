import { describe, it, expect, vi } from "vitest";
import { ensurePreview } from "./preview.js";

const PREVIEW = { serviceName: "t8a-frontend-dev", subdir: "frontend", installCheckDir: "frontend/node_modules" };

describe("ensurePreview", () => {
  it("no-op when preview is undefined", async () => {
    const exec = vi.fn();
    const r = await ensurePreview("/repo", undefined, { exec, exists: () => true });
    expect(r.started).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
  it("installs deps when installCheckDir missing, then restarts the unit", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const r = await ensurePreview("/repo", PREVIEW, { exec, exists: () => false });
    expect(exec).toHaveBeenCalledWith("npm", ["ci"], expect.objectContaining({ cwd: "/repo/frontend" }));
    expect(exec).toHaveBeenCalledWith("sudo", ["systemctl", "restart", "t8a-frontend-dev"], expect.anything());
    expect(r.started).toBe(true);
  });
  it("skips install when deps present, still restarts", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await ensurePreview("/repo", PREVIEW, { exec, exists: () => true });
    expect(exec).not.toHaveBeenCalledWith("npm", ["ci"], expect.anything());
    expect(exec).toHaveBeenCalledWith("sudo", ["systemctl", "restart", "t8a-frontend-dev"], expect.anything());
  });
});
