import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isRepoAllowed, parseRepoRef, cloneAllowedRepo } from "./clone.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// parseRepoRef
// ---------------------------------------------------------------------------

describe("parseRepoRef", () => {
  it("parses bare owner/name defaulting to github.com", () => {
    const r = parseRepoRef("acme/widget");
    expect(r).toEqual({ host: "github.com", owner: "acme", name: "widget" });
  });

  it("parses https URL", () => {
    const r = parseRepoRef("https://github.com/acme/widget.git");
    expect(r).toEqual({ host: "github.com", owner: "acme", name: "widget" });
  });

  it("parses SSH-style ref", () => {
    const r = parseRepoRef("git@github.com:acme/widget.git");
    expect(r).toEqual({ host: "github.com", owner: "acme", name: "widget" });
  });

  it("parses GHE SSH ref", () => {
    const r = parseRepoRef("git@ghe.corp:acme/widget.git");
    expect(r).toEqual({ host: "ghe.corp", owner: "acme", name: "widget" });
  });

  it("parses GHE https ref", () => {
    const r = parseRepoRef("https://ghe.corp/acme/widget");
    expect(r).toEqual({ host: "ghe.corp", owner: "acme", name: "widget" });
  });

  it("normalises host to lowercase", () => {
    const r = parseRepoRef("https://GitHub.COM/Acme/Widget");
    expect(r?.host).toBe("github.com");
    // owner and name preserve original case
    expect(r?.owner).toBe("Acme");
    expect(r?.name).toBe("Widget");
  });

  it("returns null for owner with semicolon", () => {
    expect(parseRepoRef("acme;bad/widget")).toBeNull();
  });

  it("returns null for name with space", () => {
    expect(parseRepoRef("acme/wi dget")).toBeNull();
  });

  it("returns null for owner with ..", () => {
    expect(parseRepoRef("../evil/widget")).toBeNull();
  });

  it("returns null for owner starting with -", () => {
    expect(parseRepoRef("-flag/widget")).toBeNull();
  });

  it("returns null for name starting with -", () => {
    expect(parseRepoRef("acme/-flag")).toBeNull();
  });

  it("returns null for https URL with only one path segment", () => {
    expect(parseRepoRef("https://github.com/acme")).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(parseRepoRef("not-a-repo")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRepoRef("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isRepoAllowed — full-identity comparisons
// ---------------------------------------------------------------------------

describe("isRepoAllowed", () => {
  // ── ALLOW cases ──

  it("allows bare owner/name against bare owner/name allowlist entry", () => {
    expect(isRepoAllowed("acme/widget", ["acme/widget"])).toBe(true);
  });

  it("allows https URL against bare owner/name allowlist entry (same host github.com)", () => {
    expect(isRepoAllowed("https://github.com/acme/widget.git", ["acme/widget"])).toBe(true);
  });

  it("allows SSH ref against bare owner/name allowlist entry", () => {
    expect(isRepoAllowed("git@github.com:acme/widget.git", ["acme/widget"])).toBe(true);
  });

  it("allows bare owner/name against full https allowlist entry", () => {
    expect(isRepoAllowed("acme/widget", ["https://github.com/acme/widget.git"])).toBe(true);
  });

  it("comparison is case-insensitive for owner and name", () => {
    expect(isRepoAllowed("Acme/Widget", ["acme/widget"])).toBe(true);
  });

  // ── REJECT cases — the key security boundary ──

  it("REJECTS https://evil.com/acme/widget when allowlist is ['acme/widget'] (host mismatch)", () => {
    expect(isRepoAllowed("https://evil.com/acme/widget", ["acme/widget"])).toBe(false);
  });

  it("REJECTS attacker.com/acme/widget (invalid bare ref with extra segment) for ['acme/widget']", () => {
    // Three-segment bare string is not a valid owner/name; parseRepoRef returns null.
    expect(isRepoAllowed("attacker.com/acme/widget", ["acme/widget"])).toBe(false);
  });

  it("REJECTS owner/name when not in allowlist", () => {
    expect(isRepoAllowed("acme/widget", ["acme/other", "acme/foo"])).toBe(false);
  });

  it("rejects when allowlist is empty", () => {
    expect(isRepoAllowed("acme/widget", [])).toBe(false);
  });

  it("rejects unparseable ref", () => {
    expect(isRepoAllowed("not-a-repo", ["acme/widget"])).toBe(false);
  });

  it("rejects ref with dangerous chars", () => {
    expect(isRepoAllowed("acme;evil/widget", ["acme/widget"])).toBe(false);
  });

  // ── GHE host tests ──

  it("allows GHE SSH ref against GHE https allowlist entry", () => {
    expect(isRepoAllowed("git@ghe.corp:acme/widget.git", ["https://ghe.corp/acme/widget"])).toBe(true);
  });

  it("REJECTS GHE SSH ref against bare allowlist entry (github.com != ghe.corp)", () => {
    expect(isRepoAllowed("git@ghe.corp:acme/widget.git", ["acme/widget"])).toBe(false);
  });

  it("REJECTS github.com ref against GHE allowlist entry", () => {
    expect(isRepoAllowed("acme/widget", ["https://ghe.corp/acme/widget"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cloneAllowedRepo (token git)
// ---------------------------------------------------------------------------

describe("cloneAllowedRepo (token git)", () => {
  const allowlist = ["acme/webapp"];
  it("clones the https URL with the token env (no gh, token not on argv)", async () => {
    const calls: { cmd: string; args: string[]; hasToken: boolean }[] = [];
    const exec = async (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => {
      calls.push({ cmd, args, hasToken: env?.TWEAKLET_GIT_TOKEN === "tok" });
      return { code: 0, stdout: "", stderr: "" };
    };
    await cloneAllowedRepo("acme/webapp", { allowlist, sourceDir: "/tmp/zzz-not-real-clone-test", baseBranch: "main", token: "tok" }, exec);
    const clone = calls.find((c) => c.args.includes("clone"))!; // after the hardening -c flags
    expect(clone.cmd).toBe("git");
    expect(clone.args).toContain("https://github.com/acme/webapp");
    expect(clone.hasToken).toBe(true);
    expect(calls.every((c) => !c.args.join(" ").includes("tok"))).toBe(true); // token never on argv
    expect(calls.some((c) => c.cmd === "gh")).toBe(false);                    // gh dropped
  });

  const HARDENING = ["core.hooksPath=/dev/null", "core.fsmonitor=", "credential.helper=", "protocol.allow=never", "protocol.https.allow=always"];
  const sub = (args: string[]) => args.find((a) => ["clone", "fetch", "switch", "remote"].includes(a))!;

  it("hardens every token-carrying call and gives the token to no other call", async () => {
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const exec = async (_cmd: string, args: string[], env?: NodeJS.ProcessEnv) => { calls.push({ args, env }); return { stdout: "" }; };
    await cloneAllowedRepo("https://ghe.example.com/acme/webapp", { allowlist: ["https://ghe.example.com/acme/webapp"], sourceDir: "/tmp/zzz-not-real-clone-test", baseBranch: "main", token: "tok" }, exec);
    for (const c of calls) {
      if (c.env?.TWEAKLET_GIT_TOKEN) {
        expect(c.env.TWEAKLET_GIT_HOST).toBe("ghe.example.com");
        for (const h of HARDENING) expect(c.args.indexOf(h), `${sub(c.args)} ${h}`).toBeLessThan(c.args.indexOf(sub(c.args)));
        for (const h of HARDENING) expect(c.args).toContain(h);
      }
    }
    expect(calls.find((c) => sub(c.args) === "clone")?.env?.TWEAKLET_GIT_TOKEN).toBe("tok");
    // switch runs post-checkout hooks and needs no network → no token.
    expect(calls.find((c) => sub(c.args) === "switch")?.env?.TWEAKLET_GIT_TOKEN).toBeUndefined();
  });

  describe("reusing an existing clone", () => {
    let src: string;
    beforeEach(() => {
      src = mkdtempSync(join(tmpdir(), "tweaklet-clone-"));
      mkdirSync(join(src, "webapp", ".git"), { recursive: true });
    });
    afterEach(() => rmSync(src, { recursive: true, force: true }));
    const execWithOrigin = (origin: string, calls: string[][]) => async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { stdout: sub(args) === "remote" ? `${origin}\n` : "" };
    };

    it("fetches when the directory's origin is the expected repo (.git suffix and case ignored)", async () => {
      const calls: string[][] = [];
      await cloneAllowedRepo("acme/webapp", { allowlist, sourceDir: src, baseBranch: "main", token: "tok" }, execWithOrigin("https://github.com/Acme/webapp.git", calls));
      expect(calls.some((a) => sub(a) === "fetch")).toBe(true);
    });

    it("refuses (and leaves it alone) when the directory holds a different repository", async () => {
      const calls: string[][] = [];
      await expect(
        cloneAllowedRepo("acme/webapp", { allowlist, sourceDir: src, baseBranch: "main", token: "tok" }, execWithOrigin("https://octocat:ghp_fake@evil.example/acme/webapp", calls)),
      ).rejects.toThrow(/different repository/);
      expect(calls.map(sub)).toEqual(["remote"]); // no fetch, no switch
      await expect(
        cloneAllowedRepo("acme/webapp", { allowlist, sourceDir: src, baseBranch: "main", token: "tok" }, execWithOrigin("https://octocat:ghp_fake@evil.example/acme/webapp", [])),
      ).rejects.not.toThrow(/ghp_fake/);
    });
  });

  it("rejects a repo not in the allowlist", async () => {
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(
      cloneAllowedRepo("evil/repo", { allowlist, sourceDir: "/tmp/zzz-not-real-clone-test", baseBranch: "main", token: "tok" }, exec),
    ).rejects.toThrow(/allowlist/);
  });
});
