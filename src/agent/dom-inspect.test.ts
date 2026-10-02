import { describe, it, expect, vi } from "vitest";
import { setActivePrompt, requestDomInspect, resolveDomInspect } from "./dom-inspect.js";

describe("dom-inspect round-trip", () => {
  it("returns {exists:false} when no active prompt/widget", async () => {
    setActivePrompt(null);
    expect(await requestDomInspect("h1")).toEqual({ exists: false });
  });

  it("emits a dom_inspect event and resolves with the posted result", async () => {
    const sent: any[] = [];
    const pending = new Map<string, (r: any) => void>();
    setActivePrompt({ send: (e) => sent.push(e), pending });
    const p = requestDomInspect("h1");
    // the event carries a requestId + selector
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "dom_inspect", selector: "h1" });
    const requestId = sent[0].requestId;
    expect(typeof requestId).toBe("string");
    // the widget posts back -> resolveDomInspect resolves the promise
    expect(resolveDomInspect(requestId, { exists: true, text: "Hi" })).toBe(true);
    expect(await p).toEqual({ exists: true, text: "Hi" });
    setActivePrompt(null);
  });

  it("resolves to {exists:false} on timeout when never answered", async () => {
    const pending = new Map<string, (r: any) => void>();
    setActivePrompt({ send: () => {}, pending });
    const r = await requestDomInspect("h1", { timeoutMs: 20 });
    expect(r).toEqual({ exists: false });
    setActivePrompt(null);
  });

  it("resolveDomInspect returns false for an unknown requestId", () => {
    setActivePrompt({ send: () => {}, pending: new Map() });
    expect(resolveDomInspect("nope", { exists: true })).toBe(false);
    setActivePrompt(null);
  });
});

describe("dom-inspect hardening", () => {
  function begin() {
    const sent: any[] = [];
    const pending = new Map<string, (r: any) => void>();
    setActivePrompt({ send: (e) => sent.push(e), pending });
    return { sent, pending };
  }

  it("uses unguessable request ids (not a counter)", async () => {
    const { sent } = begin();
    const p1 = requestDomInspect("h1", { timeoutMs: 20 });
    const p2 = requestDomInspect("h2", { timeoutMs: 20 });
    const [a, b] = [sent[0].requestId as string, sent[1].requestId as string];
    expect(a).not.toBe(b);
    expect(a).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(a).not.toMatch(/^dom_\d+$/);
    await Promise.all([p1, p2]);
    setActivePrompt(null);
  });

  it("ignores a result that is not a plain object", async () => {
    const { sent } = begin();
    const p = requestDomInspect("h1", { timeoutMs: 50 });
    const id = sent[0].requestId;
    expect(resolveDomInspect(id, null as any)).toBe(false);
    expect(resolveDomInspect(id, "x" as any)).toBe(false);
    expect(resolveDomInspect(id, [1, 2] as any)).toBe(false);
    // The request is still pending; a valid answer resolves it.
    expect(resolveDomInspect(id, { exists: true, text: "ok" })).toBe(true);
    expect(await p).toEqual({ exists: true, text: "ok" });
    setActivePrompt(null);
  });

  it("keeps only known fields with the right types", async () => {
    const { sent } = begin();
    const p = requestDomInspect("h1");
    resolveDomInspect(sent[0].requestId, { exists: true, text: 5, extra: "nope", refused: "r", computedStyle: { color: "red", bad: 1 } } as any);
    expect(await p).toEqual({ exists: true, refused: "r", computedStyle: { color: "red" } });
    setActivePrompt(null);
  });

  it("clips an oversized result to at most 20 KB of JSON", async () => {
    const { sent } = begin();
    const p = requestDomInspect("h1");
    const big = "a ".repeat(50_000);
    expect(resolveDomInspect(sent[0].requestId, { exists: true, outerHTML: big, text: big })).toBe(true);
    const r = await p;
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
    expect(r.exists).toBe(true);
    setActivePrompt(null);
  });

  it("does not call inherited Map/Object members for crafted ids", () => {
    begin();
    for (const id of ["__proto__", "constructor", "get", "toString", "hasOwnProperty"]) {
      expect(resolveDomInspect(id, { exists: true })).toBe(false);
    }
    setActivePrompt(null);
  });

  it("returns false when no prompt is active", () => {
    setActivePrompt(null);
    expect(resolveDomInspect("anything", { exists: true })).toBe(false);
  });
});
