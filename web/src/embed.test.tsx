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

import { deriveBase, isStandalone, mount } from "./embed.js";

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
  beforeEach(() => {
    document.body.innerHTML = "";
    setBaseMock.mockClear();
    // App.checkState() runs on mount; resolve to the wizard (completed:false)
    // so the heavy Panel doesn't mount — the launcher renders in either mode.
    setupApiMock.state.mockResolvedValue({ completed: false, steps: [], firstIncompleteStepId: null, checks: [], allowlist: [] });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("attaches an open shadow root with the inlined style + the app", async () => {
    mount("https://host/tweaklet/widget.js");

    const root = document.getElementById("tweaklet-root");
    expect(root).not.toBeNull();
    expect(root!.shadowRoot).not.toBeNull();
    expect(root!.shadowRoot!.mode).toBe("open");

    // CSS was injected as a <style> in the shadow (not the light DOM). The
    // exact inlined contents are a build-time concern (asserted against the
    // built dist/widget.js); here we confirm the <style> element exists in the
    // shadow tree and not in the host light DOM.
    const style = root!.shadowRoot!.querySelector("style");
    expect(style).not.toBeNull();
    expect(document.querySelector("#tweaklet-root > style")).toBeNull();
    expect(root!.shadowRoot!.querySelector(".tweaklet-shadow-mount")).not.toBeNull();

    // React renders asynchronously; the launcher button is always rendered.
    await waitFor(() =>
      expect(root!.shadowRoot!.querySelector(".apz-launcher")).not.toBeNull(),
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

  it("renders the centered card (not the launcher) in standalone mode", async () => {
    mount("https://host/tweaklet/widget.js?standalone=1");
    const root = document.getElementById("tweaklet-root")!;
    await waitFor(() =>
      expect(root.shadowRoot!.querySelector(".apz-standalone")).not.toBeNull(),
    );
    // The edge launcher is NOT used standalone.
    expect(root.shadowRoot!.querySelector(".apz-launcher")).toBeNull();
    expect(root.shadowRoot!.querySelector(".tweaklet-standalone-root")).not.toBeNull();
  });
});
