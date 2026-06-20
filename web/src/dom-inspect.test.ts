import { describe, it, expect, beforeEach } from "vitest";
import { inspectDom } from "./dom-inspect.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("inspectDom", () => {
  it("returns exists=true with text and outerHTML for a present element", () => {
    document.body.innerHTML = '<h1 id="t">Hello</h1>';
    const r = inspectDom("#t");
    expect(r.exists).toBe(true);
    expect(r.text).toBe("Hello");
    expect(r.outerHTML).toContain("Hello");
  });

  it("returns exists=false for an absent selector", () => {
    expect(inspectDom("#nope").exists).toBe(false);
  });

  it("returns exists=false for an invalid selector and does not throw", () => {
    expect(inspectDom("::::").exists).toBe(false);
  });

  it("caps outerHTML at 4000 characters", () => {
    const huge = "x".repeat(5000);
    document.body.innerHTML = `<div id="big">${huge}</div>`;
    const r = inspectDom("#big");
    expect(r.exists).toBe(true);
    expect((r.outerHTML ?? "").length).toBeLessThanOrEqual(4000);
  });

  it("caps text at 2000 characters", () => {
    const huge = "y".repeat(3000);
    document.body.innerHTML = `<p id="p">${huge}</p>`;
    const r = inspectDom("#p");
    expect(r.exists).toBe(true);
    expect((r.text ?? "").length).toBeLessThanOrEqual(2000);
  });

  it("returns a computedStyle object with the expected keys", () => {
    document.body.innerHTML = '<span id="s">hi</span>';
    const r = inspectDom("#s");
    expect(r.exists).toBe(true);
    expect(r.computedStyle).toBeDefined();
    expect(r.computedStyle).toHaveProperty("display");
  });
});
