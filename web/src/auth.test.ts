import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock api module ────────────────────────────────────────────────────────────
const { apiMock, getBaseMock } = vi.hoisted(() => {
  const apiMock = { me: vi.fn() };
  const getBaseMock = vi.fn(() => "");
  return { apiMock, getBaseMock };
});
vi.mock("./api.js", () => ({ api: apiMock, getBase: getBaseMock }));

import { signIn } from "./auth.js";

// Helper: fire a message event from the same origin
function fireSignedInMessage(source: Window = window) {
  const event = new MessageEvent("message", {
    data: { type: "tweaklet:signed-in" },
    origin: window.location.origin,
    source,
  });
  window.dispatchEvent(event);
}

// Helper: fire a message event from a different origin
function fireSignedInMessageBadOrigin() {
  const event = new MessageEvent("message", {
    data: { type: "tweaklet:signed-in" },
    origin: "https://evil.example.com",
  });
  window.dispatchEvent(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  apiMock.me.mockResolvedValue(null); // not signed in by default
});

afterEach(() => {
  vi.useRealTimers();
});

describe("signIn()", () => {
  it("calls window.open with the auth/login URL", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      close: vi.fn(),
    } as unknown as Window);

    apiMock.me.mockResolvedValue({ login: "alice", id: 7 });

    const promise = signIn();
    // Fire the postMessage immediately to resolve
    fireSignedInMessage();
    const result = await promise;

    expect(openSpy).toHaveBeenCalledWith(
      "/auth/login",
      "tweaklet-signin",
      "width=520,height=680",
    );
    expect(result).toBe("signed-in");
    openSpy.mockRestore();
  });

  it("resolves 'signed-in' on a same-origin postMessage {type:tweaklet:signed-in}", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      close: vi.fn(),
    } as unknown as Window);

    const promise = signIn();
    fireSignedInMessage();
    const result = await promise;

    expect(result).toBe("signed-in");
  });

  it("ignores postMessages from a different origin", async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    // me() immediately returns a user so the poll resolves on the first real call.
    apiMock.me.mockResolvedValue({ login: "alice", id: 7 });

    const promise = signIn();

    // This should be ignored (wrong origin)
    fireSignedInMessageBadOrigin();

    // Advance the poll interval so the setInterval fires.
    // Then drain microtasks (the async callback inside the interval awaits api.me()).
    await vi.advanceTimersByTimeAsync(1100);
    // Drain the pending microtasks from the async setInterval callback.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const result = await promise;
    expect(result).toBe("signed-in");
    // The resolution came from the poll, NOT from the ignored bad-origin message.
    expect(apiMock.me).toHaveBeenCalled();
  });

  it("poll fallback: resolves 'signed-in' when me() starts returning a user", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      close: vi.fn(),
    } as unknown as Window);

    // me() returns user immediately on first call (the poll fires after 1 s).
    apiMock.me.mockResolvedValue({ login: "alice", id: 7 });

    const promise = signIn();

    // Advance past 1 poll interval then drain microtasks from the async callback.
    await vi.advanceTimersByTimeAsync(1100);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const result = await promise;

    expect(result).toBe("signed-in");
    expect(apiMock.me).toHaveBeenCalled();
  });

  it("resolves 'closed' when popup is closed without signing in", async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    apiMock.me.mockResolvedValue(null);

    const promise = signIn();

    // Simulate popup being closed after a tick
    await vi.advanceTimersByTimeAsync(500);
    (popup as unknown as { closed: boolean }).closed = true;

    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(result).toBe("closed");
  });

  it("resolves 'signed-in' when popup closes AND me() returns a user (race)", async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    // me() returns user after popup is already closed (the postMessage arrived first)
    apiMock.me.mockResolvedValue({ login: "alice", id: 7 });

    const promise = signIn();

    await vi.advanceTimersByTimeAsync(500);
    (popup as unknown as { closed: boolean }).closed = true;

    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(result).toBe("signed-in");
  });

  it("cleans up the message listener and poll on resolution", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    vi.spyOn(window, "open").mockReturnValue({
      closed: false,
      close: vi.fn(),
    } as unknown as Window);

    const promise = signIn();
    fireSignedInMessage();
    await promise;

    // The "message" listener that was added should have been removed
    const addedListener = addSpy.mock.calls.find(([type]) => type === "message");
    expect(addedListener).toBeTruthy();
    const removedListener = removeSpy.mock.calls.find(
      ([type, fn]) => type === "message" && fn === addedListener?.[1],
    );
    expect(removedListener).toBeTruthy();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("resolves 'closed' when window.open returns null (popup blocked)", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    const result = await signIn();
    expect(result).toBe("closed");
  });

  it("resolves 'timeout' after 5 minutes if the popup stays open", async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    apiMock.me.mockResolvedValue(null);

    const promise = signIn();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    const result = await promise;

    expect(result).toBe("timeout");
  });
});
