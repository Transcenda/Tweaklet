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
