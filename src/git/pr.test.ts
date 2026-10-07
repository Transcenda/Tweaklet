import { describe, it, expect } from "vitest";
import { createDraftPr, repoSlugFromRemote } from "./pr.js";

describe("createDraftPr (REST + token)", () => {
  it("pushes with the token env then POSTs a draft PR via REST", async () => {
    const pushed: { hasToken: boolean }[] = [];
    const exec = async (cmd: string, args: string[], _cwd: string, env?: NodeJS.ProcessEnv) => {
      if (args.includes("push")) pushed.push({ hasToken: env?.TWEAKLET_GIT_TOKEN === "tok" });
      return { stdout: "", stderr: "", code: 0 };
    };
    let posted: any = null;
    const fetchImpl = (async (url: string, init: any) => {
      posted = { url, init };
      return { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/o/r/pull/1" }) } as Response;
    }) as typeof fetch;
    const url = await createDraftPr("/cwd",
      { branch: "tweaklet/x", title: "T", body: "B", base: "main", owner: "o", repo: "r", token: "tok", apiBaseUrl: "https://api.github.com" },
      exec, fetchImpl);
    expect(url).toBe("https://github.com/o/r/pull/1");
    expect(pushed[0].hasToken).toBe(true);
    expect(posted.url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(posted.init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(posted.init.body)).toMatchObject({ title: "T", head: "tweaklet/x", base: "main", draft: true });
  });
});

describe("createDraftPr push hardening", () => {
  const okFetch = (async () => ({ ok: true, status: 201, json: async () => ({ html_url: "u" }) }) as Response) as typeof fetch;
  it("pushes with hooks, credential helpers and non-https transports disabled, past repo hooks", async () => {
    let push: { args: string[]; env?: NodeJS.ProcessEnv } | null = null;
    const exec = async (_cmd: string, args: string[], _cwd: string, env?: NodeJS.ProcessEnv) => {
      if (args.includes("push")) push = { args, env };
      return { stdout: "", stderr: "", code: 0 };
    };
    await createDraftPr("/cwd",
      { branch: "tweaklet/x", title: "T", body: "B", base: "main", owner: "acme", repo: "webapp", token: "tok", apiBaseUrl: "https://ghe.example.com/api/v3" },
      exec, okFetch);
    const { args, env } = push!;
    const sub = args.indexOf("push");
    for (const c of ["core.hooksPath=/dev/null", "core.fsmonitor=", "credential.helper=", "protocol.allow=never", "protocol.https.allow=always"]) {
      expect(args.indexOf(c), c).toBeGreaterThan(-1);
      expect(args.indexOf(c)).toBeLessThan(sub);
    }
    expect(args.slice(sub)).toContain("--no-verify");
    expect(env?.TWEAKLET_GIT_HOST).toBe("ghe.example.com");
    expect(args.join(" ")).not.toContain("tok ");
  });
});

describe("repoSlugFromRemote", () => {
  it("never echoes credentials embedded in the origin URL", async () => {
    const bad = async () => ({ stdout: "https://octocat:ghp_fakefake@example.com/only-one\n", stderr: "", code: 0 });
    await expect(repoSlugFromRemote("/cwd", bad)).rejects.toThrow(/https:\/\/\*\*\*@example\.com/);
    await expect(repoSlugFromRemote("/cwd", bad)).rejects.not.toThrow(/ghp_fakefake/);
    const noOrigin = async () => ({ stdout: "", stderr: "fatal: unable to access 'https://tok123@example.com/acme/webapp'", code: 2 });
    await expect(repoSlugFromRemote("/cwd", noOrigin)).rejects.not.toThrow(/tok123/);
  });

  it("parses owner/name from the origin https url", async () => {
    const exec = async () => ({ stdout: "https://github.com/acme/webapp\n", stderr: "", code: 0 });
    expect(await repoSlugFromRemote("/cwd", exec)).toEqual({ owner: "acme", name: "webapp" });
  });
});
