import { describe, it, expect } from "vitest";
import { ghCliUser } from "./gh-cli.js";

describe("ghCliUser", () => {
  it("returns the user from gh api user output", async () => {
    const exec = async () => ({ stdout: '{"id":583231,"login":"octocat"}' });
    expect(await ghCliUser(exec)).toMatchObject({ login: "octocat", id: 583231 });
  });
  it("returns null when gh exits non-zero / not installed", async () => {
    const exec = async () => { throw new Error("gh: command not found"); };
    expect(await ghCliUser(exec)).toBeNull();
  });
  it("returns null on malformed output", async () => {
    const exec = async () => ({ stdout: "not json" });
    expect(await ghCliUser(exec)).toBeNull();
  });
  it("returns null when login/id missing", async () => {
    const exec = async () => ({ stdout: '{"name":"x"}' });
    expect(await ghCliUser(exec)).toBeNull();
  });
});
