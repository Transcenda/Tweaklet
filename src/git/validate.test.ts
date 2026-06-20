import { describe, it, expect } from "vitest";
import { assertSafeRef } from "./validate.js";

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
