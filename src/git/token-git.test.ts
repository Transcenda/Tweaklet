import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { tokenGitEnv, ensureAskpass } from "./token-git.js";

const run = promisify(execFile);

describe("tokenGitEnv", () => {
  it("returns GIT_ASKPASS + token env (token NOT on argv)", () => {
    const env = tokenGitEnv("ghs_abc");
    expect(existsSync(env.GIT_ASKPASS!)).toBe(true);
    expect(env.TWEAKLET_GIT_TOKEN).toBe("ghs_abc");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("the askpass script answers username=x-access-token and password=<token>", async () => {
    const p = ensureAskpass();
    const e = { ...process.env, TWEAKLET_GIT_TOKEN: "ghs_secret" };
    const user = await run(p, ["Username for 'https://github.com': "], { env: e });
    const pass = await run(p, ["Password for 'https://github.com': "], { env: e });
    expect(user.stdout).toBe("x-access-token");
    expect(pass.stdout).toBe("ghs_secret");
  });
});
