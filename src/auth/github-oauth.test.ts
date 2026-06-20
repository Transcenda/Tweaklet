import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchGithubUser } from "./github-oauth.js";

describe("github-oauth", () => {
  it("builds an authorize URL with the right params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: "http://localhost:4319/auth/callback",
        state: "st8",
        oauthBaseUrl: "https://github.com",
      }),
    );
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4319/auth/callback");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("scope")).toBe("repo read:user user:email");
  });

  it("exchanges a code for an access token", async () => {
    const fakeFetch = async (input: string, init?: any) => {
      expect(input).toBe("https://github.com/login/oauth/access_token");
      expect(init.headers.Accept).toBe("application/json");
      return { ok: true, json: async () => ({ access_token: "gho_tok" }) } as any;
    };
    const tok = await exchangeCodeForToken(
      { code: "c", clientId: "cid", clientSecret: "sec", redirectUri: "http://x/cb", oauthBaseUrl: "https://github.com" },
      fakeFetch as any,
    );
    expect(tok).toBe("gho_tok");
  });

  it("fetches the github user login", async () => {
    const fakeFetch = async (input: string, init?: any) => {
      expect(input).toBe("https://api.github.com/user");
      expect(init.headers.Authorization).toBe("Bearer gho_tok");
      return { ok: true, json: async () => ({ login: "alice", id: 7 }) } as any;
    };
    const user = await fetchGithubUser(
      { token: "gho_tok", apiBaseUrl: "https://api.github.com" },
      fakeFetch as any,
    );
    expect(user).toMatchObject({ login: "alice", id: 7 });
  });
});

describe("oauth scope", () => {
  it("requests repo + read:user + user:email", () => {
    const url = buildAuthorizeUrl({ clientId: "c", redirectUri: "https://h/cb", state: "s", oauthBaseUrl: "https://github.com" });
    expect(new URL(url).searchParams.get("scope")).toBe("repo read:user user:email");
  });
});

describe("fetchGithubUser name/email", () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as Response);
  it("returns name + public email from /user", async () => {
    const f = (async (u: string) => u.endsWith("/user") ? ok({ login: "alice", id: 7, name: "Alice A", email: "alice@x.com" }) : ok([])) as typeof fetch;
    const u = await fetchGithubUser({ token: "t", apiBaseUrl: "https://api.github.com" }, f);
    expect(u).toMatchObject({ login: "alice", id: 7, name: "Alice A", email: "alice@x.com" });
  });
  it("falls back to /user/emails primary when /user email is null", async () => {
    const f = (async (u: string) =>
      u.endsWith("/user") ? ok({ login: "alice", id: 7, name: null, email: null })
        : ok([{ email: "p@x.com", primary: true, verified: true }])) as typeof fetch;
    const u = await fetchGithubUser({ token: "t", apiBaseUrl: "https://api.github.com" }, f);
    expect(u.email).toBe("p@x.com");
    expect(u.name).toBe("alice"); // name falls back to login
  });
  it("falls back to noreply email when none available", async () => {
    const f = (async (u: string) => u.endsWith("/user") ? ok({ login: "alice", id: 7 }) : ok([])) as typeof fetch;
    const u = await fetchGithubUser({ token: "t", apiBaseUrl: "https://api.github.com" }, f);
    expect(u.email).toBe("7+alice@users.noreply.github.com");
  });
});
