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
