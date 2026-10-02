import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";

// Mock api.js so mounting <App/> doesn't hit the network; capture setBase calls.
const { setBaseMock, setupApiMock, apiMock } = vi.hoisted(() => ({
  setBaseMock: vi.fn(),
  setupApiMock: {
    state: vi.fn(),
    github: vi.fn().mockResolvedValue({}),
    agent: vi.fn().mockResolvedValue({}),
    repo: vi.fn().mockResolvedValue({}),
    doctor: vi.fn().mockResolvedValue({}),
    complete: vi.fn().mockResolvedValue({}),
  },
  apiMock: { me: vi.fn().mockResolvedValue(null) },
}));

vi.mock("./api.js", () => ({
  setBase: setBaseMock,
  lockFetch: vi.fn(),
  getBase: () => "",
  setupApi: setupApiMock,
  api: apiMock,
  SetupAuthError: class extends Error {},
  SETUP_TOKEN_KEY: "tweaklet.setupToken",
  streamPrompt: vi.fn(),
}));

// This test exercises the embed *mount mechanics* (shadow root, style, base),
// not the wizard/panel internals — stub the heavy children so App's launcher +
// dock shell renders without their effects firing.
vi.mock("./SetupWizard.js", () => ({ SetupWizard: () => null }));
vi.mock("./Panel.js", () => ({ Panel: () => null }));

import { deriveBase, isStandalone, mount, findScriptSrc } from "./embed.js";

const realAttachShadow = HTMLElement.prototype.attachShadow;

describe("deriveBase", () => {
  it("strips /widget.js to give origin+prefix", () => {
    expect(deriveBase("https://h/tweaklet/widget.js")).toBe("https://h/tweaklet");
  });
  it("strips a query string too", () => {
    expect(deriveBase("https://h/tweaklet/widget.js?v=2")).toBe("https://h/tweaklet");
  });
  it("strips the standalone marker too", () => {
    expect(deriveBase("https://h/tweaklet/widget.js?standalone=1")).toBe("https://h/tweaklet");
  });
  it("handles a root-mounted widget", () => {
    expect(deriveBase("https://h/widget.js")).toBe("https://h");
  });
  it("returns empty for missing src", () => {
    expect(deriveBase(null)).toBe("");
    expect(deriveBase(undefined)).toBe("");
  });
});

describe("isStandalone", () => {
  it("is true with ?standalone=1", () => {
    expect(isStandalone("https://h/tweaklet/widget.js?standalone=1")).toBe(true);
  });
  it("is true with a bare ?standalone", () => {
    expect(isStandalone("https://h/tweaklet/widget.js?standalone")).toBe(true);
  });
  it("is false without the marker (embedded mode)", () => {
    expect(isStandalone("https://h/tweaklet/widget.js")).toBe(false);
    expect(isStandalone("https://h/tweaklet/widget.js?v=2")).toBe(false);
  });
  it("is false for missing src", () => {
    expect(isStandalone(null)).toBe(false);
    expect(isStandalone(undefined)).toBe(false);
  });
});

describe("mount", () => {
  // The host now mounts on <html> (beside <body>) so the dock can shrink <body>,
  // so cleaning body.innerHTML alone won't remove it — clear the <html>-level
  // artifacts too, or they'd leak across tests.
  function cleanup() {
    document.body.innerHTML = "";
    document.getElementById("tweaklet-root")?.remove();
    document.getElementById("tweaklet-dock-style")?.remove();
    document.documentElement.classList.remove("tweaklet-docked");
  }
  beforeEach(() => {
    cleanup();
    setBaseMock.mockClear();
    // App.checkState() runs on mount; resolve to the wizard (completed:false)
    // so the heavy Panel doesn't mount — the launcher renders in either mode.
    setupApiMock.state.mockResolvedValue({ completed: false, steps: [], firstIncompleteStepId: null, checks: [], allowlist: [] });
  });
  afterEach(cleanup);

  // The shadow root is closed (host scripts can't reach in), so capture it as
  // it's attached.
  function captureShadow(): () => ShadowRoot {
    let captured: ShadowRoot | null = null;
    vi.spyOn(HTMLElement.prototype, "attachShadow").mockImplementation(function (this: HTMLElement, init: ShadowRootInit) {
      captured = realAttachShadow.call(this, init);
      return captured;
    });
    return () => captured!;
  }

  it("attaches a CLOSED shadow root with the inlined style + the app", async () => {
    const shadow = captureShadow();
    mount("https://host/tweaklet/widget.js");

    const root = document.getElementById("tweaklet-root");
    expect(root).not.toBeNull();
    expect(root!.shadowRoot).toBeNull(); // page scripts can't reach the panel
    expect(shadow().mode).toBe("closed");

    // CSS was injected as a <style> in the shadow (not the light DOM). The
    // exact inlined contents are a build-time concern (asserted against the
    // built dist/widget.js); here we confirm the <style> element exists in the
    // shadow tree and not in the host light DOM.
    const style = shadow().querySelector("style");
    expect(style).not.toBeNull();
    expect(document.querySelector("#tweaklet-root > style")).toBeNull();
    expect(shadow().querySelector(".tweaklet-shadow-mount")).not.toBeNull();

    // React renders asynchronously; the launcher button is always rendered.
    await waitFor(() =>
      expect(shadow().querySelector(".apz-launcher")).not.toBeNull(),
    );
  });

  it("derives and sets the base from the script src", () => {
    mount("https://host/tweaklet/widget.js");
    expect(setBaseMock).toHaveBeenCalledWith("https://host/tweaklet");
  });

  it("is idempotent (a second call is a no-op)", () => {
    mount("https://host/tweaklet/widget.js");
    mount("https://host/tweaklet/widget.js");
    expect(document.querySelectorAll("#tweaklet-root").length).toBe(1);
  });

  it("mounts the host on <html> (beside <body>) and injects the dock stylesheet", () => {
    mount("https://host/tweaklet/widget.js");
    const root = document.getElementById("tweaklet-root")!;
    expect(root.parentElement).toBe(document.documentElement);
    const dock = document.getElementById("tweaklet-dock-style");
    expect(dock).not.toBeNull();
    expect(dock!.textContent).toContain("html.tweaklet-docked body");
    expect(dock!.textContent).toContain("margin-right");
  });

  it("does not inject the dock stylesheet in standalone mode (no host app)", () => {
    mount("https://host/tweaklet/widget.js?standalone=1");
    expect(document.getElementById("tweaklet-dock-style")).toBeNull();
  });

  it("renders the centered card (not the launcher) in standalone mode", async () => {
    const shadow = captureShadow();
    mount("https://host/tweaklet/widget.js?standalone=1");
    await waitFor(() =>
      expect(shadow().querySelector(".apz-standalone")).not.toBeNull(),
    );
    // The edge launcher is NOT used standalone.
    expect(shadow().querySelector(".apz-launcher")).toBeNull();
    expect(shadow().querySelector(".tweaklet-standalone-root")).not.toBeNull();
  });
});

describe("findScriptSrc (DOM-clobbering safe)", () => {
  const here = () => window.location.origin;
  beforeEach(() => { document.body.innerHTML = ""; vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

  function addScript(src: string) {
    const s = document.createElement("script");
    s.setAttribute("src", src);
    s.type = "text/plain"; // never executed by jsdom
    document.body.appendChild(s);
  }

  it("accepts a same-origin <script> whose path ends in /widget.js", () => {
    addScript("/tweaklet/widget.js?v=2");
    expect(findScriptSrc()).toBe(`${here()}/tweaklet/widget.js?v=2`);
  });

  it("ignores a cross-origin widget.js script", () => {
    addScript("https://attacker.example.com/tweaklet/widget.js");
    expect(findScriptSrc()).toBe("");
    expect(console.warn).toHaveBeenCalled();
  });

  it("ignores same-origin scripts that are not widget.js", () => {
    addScript("/assets/widget.js.map");
    addScript("/evil.js?x=/widget.js");
    expect(findScriptSrc()).toBe("");
  });

  it("ignores clobbered document.currentScript / non-script elements named like the widget", () => {
    document.body.innerHTML =
      '<img name="currentScript" src="https://attacker.example.com/widget.js">' +
      '<form name="scripts"><input name="src" value="https://attacker.example.com/widget.js"></form>' +
      '<a id="widget" href="https://attacker.example.com/widget.js">x</a>';
    expect(findScriptSrc()).toBe("");
  });

  it("prefers the real same-origin script even when clobbering elements are present", () => {
    document.body.innerHTML = '<img name="currentScript" src="https://attacker.example.com/widget.js">';
    addScript("/tweaklet/widget.js");
    expect(findScriptSrc()).toBe(`${here()}/tweaklet/widget.js`);
  });
});
