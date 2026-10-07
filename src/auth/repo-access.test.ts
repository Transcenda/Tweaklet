import { describe, it, expect, vi } from "vitest";
import { hasPushAccess } from "./repo-access.js";

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const args = { token: "tok", owner: "acme", name: "webapp", apiBaseUrl: "https://api.github.com" };

describe("hasPushAccess", () => {
  it("asks GitHub about the repo with the user's own token", async () => {
    const f = vi.fn(async () => res(200, { permissions: { push: true } }));
    expect(await hasPushAccess(args, f)).toBe(true);
    expect(f).toHaveBeenCalledWith("https://api.github.com/repos/acme/webapp", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer tok" }),
    }));
  });
  it.each([
    ["admin", { admin: true, push: false }],
    ["maintain", { maintain: true, push: false }],
  ])("counts %s as write access", async (_n, permissions) => {
    expect(await hasPushAccess(args, async () => res(200, { permissions }))).toBe(true);
  });
  it("refuses read-only collaborators (they couldn't push a change anyway)", async () => {
    expect(await hasPushAccess(args, async () => res(200, { permissions: { pull: true, push: false } }))).toBe(false);
  });
  it("refuses when GitHub hides the repo (404) or forbids it (403, e.g. SSO not authorized)", async () => {
    expect(await hasPushAccess(args, async () => res(404, {}))).toBe(false);
    expect(await hasPushAccess(args, async () => res(403, {}))).toBe(false);
  });
  it("refuses (fails closed) on a network error", async () => {
    expect(await hasPushAccess(args, async () => { throw new Error("offline"); })).toBe(false);
  });
  it("never puts unsafe owner/name into the URL", async () => {
    const f = vi.fn(async () => res(200, { permissions: { push: true } }));
    expect(await hasPushAccess({ ...args, owner: "../evil" }, f)).toBe(false);
    expect(await hasPushAccess({ ...args, name: ".." }, f)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(await hasPushAccess({ ...args, name: ".github" }, f)).toBe(true); // a real repo name
  });
});
