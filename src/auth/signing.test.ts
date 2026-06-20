import { describe, it, expect } from "vitest";
import { sign, verify } from "./signing.js";

const secret = "s".repeat(32);

describe("signing", () => {
  it("round-trips a payload", () => {
    const t = sign({ login: "alice", id: 7 }, secret);
    expect(verify<{ login: string; id: number }>(t, secret)).toEqual({ login: "alice", id: 7 });
  });
  it("returns null on tampering", () => {
    const t = sign({ login: "alice" }, secret);
    expect(verify(t + "x", secret)).toBeNull();
  });
  it("returns null on the wrong secret", () => {
    const t = sign({ login: "alice" }, secret);
    expect(verify(t, "other".repeat(8))).toBeNull();
  });
  it("returns null on malformed input", () => {
    expect(verify("not-a-token", secret)).toBeNull();
  });
});
