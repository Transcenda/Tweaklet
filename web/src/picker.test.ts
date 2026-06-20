import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// picker.ts uses document / window — jsdom provides them.
import { startPick, highlightElement, clearHighlight } from "./picker.js";

const OVERLAY_ID = "__tweaklet_picker_overlay__";
const ROOT_ID = "tweaklet-root";

function getOverlay(): HTMLElement | null {
  return document.getElementById(OVERLAY_ID);
}

// jsdom doesn't implement layout, so getBoundingClientRect always throws.
// Stub it on HTMLElement.prototype so positionOverlay works in tests.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 10, left: 20, width: 100, height: 50,
    bottom: 60, right: 120, x: 20, y: 10, toJSON: () => ({}),
  } as DOMRect);

  // Clean up any overlay or tweaklet-root left from a previous test.
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById(ROOT_ID)?.remove();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById(ROOT_ID)?.remove();
  document.body.innerHTML = "";
});

describe("startPick", () => {
  it("creates an overlay div on first mousemove over a host element", () => {
    const div = document.createElement("div");
    div.id = "target";
    document.body.appendChild(div);

    const onPicked = vi.fn();
    startPick(onPicked);

    // Dispatch on the element so it bubbles up to the document listener with e.target === div.
    div.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    expect(getOverlay()).not.toBeNull();
  });

  it("calls onPicked with a PickedElement when clicking a host element", () => {
    const btn = document.createElement("button");
    btn.id = "submit-btn";
    btn.className = "cta";
    btn.textContent = "Click me";
    document.body.appendChild(btn);

    const onPicked = vi.fn();
    startPick(onPicked);

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onPicked).toHaveBeenCalledTimes(1);
    const el = onPicked.mock.calls[0][0];
    expect(el.tag).toBe("button");
    expect(el.id).toBe("submit-btn");
    expect(el.classes).toContain("cta");
  });

  it("ignores clicks inside #tweaklet-root (cannot pick the widget)", () => {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);

    const inner = document.createElement("button");
    inner.id = "widget-btn";
    root.appendChild(inner);

    const onPicked = vi.fn();
    startPick(onPicked);

    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onPicked).not.toHaveBeenCalled();
  });

  it("hides the overlay when mousing over the tweaklet root", () => {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);

    const inner = document.createElement("span");
    root.appendChild(inner);

    const target = document.createElement("div");
    document.body.appendChild(target);

    const onPicked = vi.fn();
    startPick(onPicked);

    // First move over a real host element so the overlay exists
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(getOverlay()).not.toBeNull();

    // Then move over the tweaklet inner element — overlay should be hidden
    inner.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(getOverlay()?.style.display).toBe("none");
  });

  it("Esc cancels picking and removes the overlay", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);

    const onPicked = vi.fn();
    startPick(onPicked);

    // Create the overlay first
    div.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(getOverlay()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(getOverlay()).toBeNull();
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("returned cleanup fn removes listeners and the overlay", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);

    const onPicked = vi.fn();
    const cleanup = startPick(onPicked);

    // Trigger overlay creation
    btn.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

    cleanup();

    expect(getOverlay()).toBeNull();

    // Click after cleanup — onPicked must NOT fire
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("click removes the overlay automatically (single-pick)", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);

    startPick(vi.fn());

    btn.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(getOverlay()).not.toBeNull();

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(getOverlay()).toBeNull();
  });
});

describe("highlightElement / clearHighlight", () => {
  it("creates an overlay positioned over the given element", () => {
    const div = document.createElement("div");
    div.id = "highlight-me";
    document.body.appendChild(div);

    highlightElement(div);

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay?.style.display).not.toBe("none");
  });

  it("resolves a CSS selector string to the element", () => {
    const btn = document.createElement("button");
    btn.id = "my-btn";
    document.body.appendChild(btn);

    highlightElement("#my-btn");

    expect(getOverlay()).not.toBeNull();
  });

  it("clears the overlay on clearHighlight()", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);

    highlightElement(div);
    expect(getOverlay()).not.toBeNull();

    clearHighlight();
    expect(getOverlay()).toBeNull();
  });

  it("is a no-op when selector matches nothing", () => {
    // Should not throw
    expect(() => highlightElement("#does-not-exist")).not.toThrow();
    expect(getOverlay()).toBeNull();
  });
});
