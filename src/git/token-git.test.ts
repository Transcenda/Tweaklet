import { describe, it, expect } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenGitEnv, ensureAskpass, authGitArgs, authGit, gitHostFromApiBase, GIT_AUTH_HARDENING } from "./token-git.js";

const run = promisify(execFile);

describe("tokenGitEnv", () => {
  it("returns GIT_ASKPASS + token env (token NOT on argv)", () => {
    const env = tokenGitEnv("ghs_abc");
    expect(existsSync(env.GIT_ASKPASS!)).toBe(true);
    expect(env.TWEAKLET_GIT_TOKEN).toBe("ghs_abc");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("scopes the token to github.com by default, or to the given host", () => {
    expect(tokenGitEnv("t").TWEAKLET_GIT_HOST).toBe("github.com");
    expect(tokenGitEnv("t", "GHE.Example.com").TWEAKLET_GIT_HOST).toBe("ghe.example.com");
  });
});

describe("askpass helper", () => {
  const ask = async (prompt: string, host: string | null = "github.com") => {
    const env: NodeJS.ProcessEnv = { ...process.env, TWEAKLET_GIT_TOKEN: "ghs_secret" };
    if (host === null) delete env.TWEAKLET_GIT_HOST; else env.TWEAKLET_GIT_HOST = host;
    return (await run(ensureAskpass(), [prompt], { env })).stdout;
  };

  it("answers username=x-access-token and password=<token> for the expected host", async () => {
    expect(await ask("Username for 'https://github.com': ")).toBe("x-access-token");
    expect(await ask("Password for 'https://x-access-token@github.com': ")).toBe("ghs_secret");
    expect(await ask("Password for 'https://x-access-token@github.com/acme/webapp.git': ")).toBe("ghs_secret");
    expect(await ask("Password for 'https://x-access-token@ghe.example.com:8443': ", "ghe.example.com:8443")).toBe("ghs_secret");
  });

  it("prints nothing for any other host, lookalike, scheme or prompt", async () => {
    for (const p of [
      "Password for 'https://x-access-token@evil.example': ",
      "Password for 'https://x-access-token@github.com.evil.example': ",
      "Password for 'https://evil.example/x@github.com': ",
      "Password for 'https://evil.example/github.com': ",
      "Password for 'http://x-access-token@github.com': ",
      "Enter passphrase for key '/tmp/id_ed25519': ",
      "",
    ]) {
      expect(await ask(p), p).toBe("");
    }
  });

  it("prints nothing when no expected host is set", async () => {
    expect(await ask("Password for 'https://x-access-token@github.com': ", null)).toBe("");
    expect(await ask("Password for 'https://x-access-token@github.com': ", "")).toBe("");
  });
});

describe("authenticated git invocations", () => {
  it("authGitArgs puts the hardening config before the subcommand", () => {
    const a = authGitArgs(["push", "origin", "main"]);
    expect(a.slice(-3)).toEqual(["push", "origin", "main"]);
    for (const c of ["core.hooksPath=/dev/null", "core.fsmonitor=", "credential.helper=", "protocol.allow=never", "protocol.https.allow=always"]) {
      const i = a.indexOf(c);
      expect(i, c).toBeGreaterThan(0);
      expect(a[i - 1]).toBe("-c");
      expect(i).toBeLessThan(a.indexOf("push"));
    }
    expect(a.slice(0, GIT_AUTH_HARDENING.length)).toEqual([...GIT_AUTH_HARDENING]);
  });

  it("authGit pairs the hardened argv with the host-scoped token env", () => {
    const { args, env } = authGit(["fetch", "origin"], "tok", "ghe.example.com");
    expect(args).toContain("credential.helper=");
    expect(args.join(" ")).not.toContain("tok");
    expect(env.TWEAKLET_GIT_TOKEN).toBe("tok");
    expect(env.TWEAKLET_GIT_HOST).toBe("ghe.example.com");
  });

  it("the hardening really disables repo hooks and credential helpers", () => {
    const dir = mkdtempSync(join(tmpdir(), "tweaklet-harden-"));
    try {
      const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      g("init", "-q", "-b", "main");
      // A repo-controlled hooks dir (like .husky) and credential helper.
      mkdirSync(join(dir, "hooks"));
      writeFileSync(join(dir, "hooks", "pre-commit"), "#!/bin/sh\necho ran > hook-ran\n");
      chmodSync(join(dir, "hooks", "pre-commit"), 0o755);
      g("config", "core.hooksPath", "hooks");
      const marker = join(dir, "helper-ran");
      g("config", "credential.helper", `!f() { echo hit >> '${marker}'; }; f`);
      g(...authGitArgs(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"]));
      expect(existsSync(join(dir, "hook-ran"))).toBe(false);
      // `approve` hands the credential to every configured helper (i.e. caches it).
      const approve = (args: string[]) => execFileSync("git", [...args, "credential", "approve"], {
        cwd: dir, input: "protocol=https\nhost=example.com\nusername=octocat\npassword=tok\n\n",
      });
      approve(authGitArgs([]));
      expect(existsSync(marker)).toBe(false);
      approve([]); // control: without the hardening the repo's helper does run
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitHostFromApiBase", () => {
  it("maps the GitHub API base to the git web host", () => {
    expect(gitHostFromApiBase("https://api.github.com")).toBe("github.com");
    expect(gitHostFromApiBase("https://ghe.example.com/api/v3")).toBe("ghe.example.com");
    expect(gitHostFromApiBase("https://api.acme.ghe.com")).toBe("acme.ghe.com");
    expect(gitHostFromApiBase("not a url")).toBe("github.com");
  });
});
