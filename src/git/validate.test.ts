import { describe, it, expect } from "vitest";
import { assertSafeRef, assertSha, redactUrlCredentials } from "./validate.js";

describe("assertSafeRef", () => {
  it("accepts normal refs", () => {
    expect(() => assertSafeRef("main")).not.toThrow();
    expect(() => assertSafeRef("sandbox/alice-bigger-box")).not.toThrow();
    expect(() => assertSafeRef("release/1.2.3")).not.toThrow();
  });
  it("rejects a leading dash (flag smuggling)", () => {
    expect(() => assertSafeRef("-X")).toThrow(/start with/);
    expect(() => assertSafeRef("--upload-pack=evil")).toThrow(/start with/);
  });
  it("rejects illegal characters and empties", () => {
    expect(() => assertSafeRef("a b")).toThrow(/illegal/);
    expect(() => assertSafeRef("a;rm -rf /")).toThrow(/illegal/);
    expect(() => assertSafeRef("")).toThrow(/empty/);
  });
});

describe("assertSha", () => {
  it("accepts abbreviated and full lowercase hex commit ids", () => {
    expect(() => assertSha("abc1234")).not.toThrow();
    expect(() => assertSha("e".repeat(40))).not.toThrow();
  });
  it("rejects refs, revision expressions, flags and out-of-range lengths", () => {
    for (const bad of ["main", "HEAD", "HEAD~1", "abc1234^", "-abc1234", "--orphan", "abc123", "a".repeat(41), "ABC1234", "", "abc1234 "]) {
      expect(() => assertSha(bad), bad).toThrow(/invalid/);
    }
  });
});

describe("redactUrlCredentials", () => {
  it("masks user:password and bare-token userinfo in URLs", () => {
    expect(redactUrlCredentials("fatal: https://octocat:ghp_fake@example.com/acme/webapp failed"))
      .toBe("fatal: https://***@example.com/acme/webapp failed");
    expect(redactUrlCredentials("https://x-access-token@github.com/acme/webapp.git"))
      .toBe("https://***@github.com/acme/webapp.git");
    expect(redactUrlCredentials("a http://u:p@one.example and ssh+git://tok@two.example/x"))
      .toBe("a http://***@one.example and ssh+git://***@two.example/x");
  });
  it("leaves credential-free text and scp-style ssh remotes alone", () => {
    expect(redactUrlCredentials("https://github.com/acme/webapp")).toBe("https://github.com/acme/webapp");
    expect(redactUrlCredentials("git@github.com:acme/webapp.git")).toBe("git@github.com:acme/webapp.git");
    expect(redactUrlCredentials("email octocat@example.com")).toBe("email octocat@example.com");
  });
  it("stays fast on adversarial input", () => {
    const t0 = Date.now();
    redactUrlCredentials("a".repeat(100_000) + "://" + "b".repeat(100_000));
    redactUrlCredentials("a://".repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
