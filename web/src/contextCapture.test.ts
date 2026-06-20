import { describe, it, expect } from "vitest";
import { serializeElement, formatContext } from "./contextCapture.js";

function dom(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("serializeElement", () => {
  it("captures tag, id, classes, curated attrs, selector path, text, opening tag", () => {
    dom(`<main><section class="checkout"><form id="pay"><button id="go" class="cta primary" type="submit" data-testid="place-order" aria-label="Place order" style="color:red">Place order</button></form></section></main>`);
    const btn = document.querySelector("button")!;
    const s = serializeElement(btn);
    expect(s.tag).toBe("button");
    expect(s.id).toBe("go");
    expect(s.classes).toEqual(["cta", "primary"]);
    expect(s.attrs).toEqual({ type: "submit", "data-testid": "place-order", "aria-label": "Place order" });
    expect(s.selectorPath).toBe("main > section.checkout > form#pay > button#go.cta.primary");
    expect(s.text).toBe("Place order");
    expect(s.html).toMatch(/^<button[^>]*>$/);
  });

  it("handles no id / no classes / no capturable attrs", () => {
    const span = dom(`<div><span>hi</span></div>`).querySelector("span")!;
    const s = serializeElement(span);
    expect(s.id).toBe("");
    expect(s.classes).toEqual([]);
    expect(s.attrs).toEqual({});
    expect(s.selectorPath).toBe("div > span");
  });

  it("trims long text to 120 chars", () => {
    const p = dom(`<p>${"x".repeat(200)}</p>`);
    expect(serializeElement(p).text).toHaveLength(120);
  });
});

describe("formatContext", () => {
  const el = (over = {}) => ({ tag: "button", id: "go", classes: ["cta"], attrs: { type: "submit" }, selectorPath: "form#pay > button#go.cta", text: "Place order", html: "<button>", ...over });

  it("formats page + a single element (no number)", () => {
    const out = formatContext({ route: "/checkout", title: "Checkout" }, [el()]);
    expect(out).toContain("[Page] route: /checkout · title: \"Checkout\"");
    expect(out).toContain("[Selected element] button#go.cta");
    expect(out).toContain("selector: form#pay > button#go.cta");
    expect(out).toContain("attrs: type=submit");
  });

  it("numbers multiple elements", () => {
    const out = formatContext(null, [el(), el({ tag: "div", id: "", classes: ["card"], selectorPath: "main > div.card" })]);
    expect(out).toContain("[Selected element 1] button#go.cta");
    expect(out).toContain("[Selected element 2] div.card");
  });

  it("page only when no elements; empty when neither", () => {
    expect(formatContext({ route: "/x", title: "X" }, [])).toContain("[Page] route: /x");
    expect(formatContext({ route: "/x", title: "X" }, [])).not.toContain("[Selected element]");
    expect(formatContext(null, [])).toBe("");
  });
});
