import { describe, it, expect } from "vitest";
import { createDraftPr, repoSlugFromRemote } from "./pr.js";

describe("createDraftPr (REST + token)", () => {
  it("pushes with the token env then POSTs a draft PR via REST", async () => {
    const pushed: { hasToken: boolean }[] = [];
    const exec = async (cmd: string, args: string[], _cwd: string, env?: NodeJS.ProcessEnv) => {
      if (args[0] === "push") pushed.push({ hasToken: env?.TWEAKLET_GIT_TOKEN === "tok" });
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

describe("repoSlugFromRemote", () => {
  it("parses owner/name from the origin https url", async () => {
    const exec = async () => ({ stdout: "https://github.com/transcenda/t8a\n", stderr: "", code: 0 });
    expect(await repoSlugFromRemote("/cwd", exec)).toEqual({ owner: "transcenda", name: "t8a" });
  });
});
