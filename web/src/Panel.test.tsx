import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

const { apiMock, streamPrompt } = vi.hoisted(() => {
  const apiMock = {
    me: vi.fn(),
    startIdea: vi.fn(),
    checkpoint: vi.fn(),
    undo: vi.fn(),
    reject: vi.fn(),
    refresh: vi.fn(),
    createPr: vi.fn(),
    prStatus: vi.fn(),
    doctor: vi.fn(),
    stop: vi.fn(),
    respondPermission: vi.fn(),
    state: vi.fn(),
    preview: vi.fn(),
    exitPreview: vi.fn(),
    restore: vi.fn(),
    repos: vi.fn(),
    clone: vi.fn(),
    history: vi.fn(),
  };
  const streamPrompt = vi.fn();
  return { apiMock, streamPrompt };
});
vi.mock("./api.js", () => ({ api: apiMock, streamPrompt, getBase: () => "" }));

// Mock auth so Panel tests can control signIn() behaviour.
const { authMock } = vi.hoisted(() => {
  const authMock = { signIn: vi.fn() };
  return { authMock };
});
vi.mock("./auth.js", () => authMock);

// Mock picker so Panel tests control when onPicked fires, and can assert no postMessage.
const { pickerMocks } = vi.hoisted(() => {
  const pickerMocks = {
    startPick: vi.fn(),
    highlightElement: vi.fn(),
    clearHighlight: vi.fn(),
  };
  return { pickerMocks };
});
vi.mock("./picker.js", () => pickerMocks);

import { Panel } from "./Panel.js";

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.me.mockResolvedValue({ login: "alice", id: 7 });
  apiMock.doctor.mockResolvedValue({ checks: [] });
  apiMock.stop.mockResolvedValue(undefined);
  apiMock.respondPermission.mockResolvedValue(undefined);
  apiMock.state.mockResolvedValue({ branch: "main", base: "main", onFeature: false, commits: [], previewing: null });
  apiMock.preview.mockResolvedValue(undefined);
  apiMock.exitPreview.mockResolvedValue(undefined);
  apiMock.restore.mockResolvedValue(undefined);
  // Default: repos resolves with cloned=true so all existing tests see the normal agent UI.
  apiMock.repos.mockResolvedValue({ allowlist: [], cloned: true });
  apiMock.clone.mockResolvedValue({ path: "/tmp/repo" });
  // Default: history resolves with empty events (no prior conversation).
  apiMock.history.mockResolvedValue({ events: [], sessionId: undefined });
  // Default: signIn resolves immediately with "signed-in".
  authMock.signIn.mockResolvedValue("signed-in");
  // Default: startPick captures the callback so tests can fire it manually.
  pickerMocks.startPick.mockImplementation(() => () => {});
});

describe("Panel", () => {
  it("shows a sign-in button when unauthenticated", async () => {
    apiMock.me.mockResolvedValueOnce(null);
    render(<Panel />);
    const btn = await screen.findByRole("button", { name: /continue with github/i });
    expect(btn).toBeInTheDocument();
  });

  it("clicking sign-in calls signIn() and re-fetches me() on success", async () => {
    // First call: unauthenticated; second call (after sign-in): authenticated.
    apiMock.me
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ login: "alice", id: 7 });
    authMock.signIn.mockResolvedValue("signed-in");

    render(<Panel />);
    const btn = await screen.findByRole("button", { name: /continue with github/i });
    fireEvent.click(btn);

    await waitFor(() => expect(authMock.signIn).toHaveBeenCalledTimes(1));
    // After sign-in, Panel re-fetches me() and shows the authenticated view.
    await waitFor(() => expect(apiMock.me).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /alice/i })).toBeInTheDocument();
  });

  it("sign-in button does nothing to panel state when signIn() returns 'closed'", async () => {
    apiMock.me.mockResolvedValueOnce(null);
    authMock.signIn.mockResolvedValue("closed");

    render(<Panel />);
    const btn = await screen.findByRole("button", { name: /continue with github/i });
    fireEvent.click(btn);

    await waitFor(() => expect(authMock.signIn).toHaveBeenCalledTimes(1));
    // me() was called only once (initial load) — sign-in button itself doesn't call me() on closed
    expect(apiMock.me).toHaveBeenCalledTimes(1);
    // Still on the sign-in screen
    expect(screen.getByRole("button", { name: /continue with github/i })).toBeInTheDocument();
  });

  it("greets the signed-in user and exposes the controls", async () => {
    render(<Panel />);
    expect(await screen.findByRole("button", { name: /alice/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start a new request/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit for the team to review/i })).toBeInTheDocument();
  });

  it("renders a plain-English tool action with an expandable change view", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "message.updated", raw: { info: { id: "m1", role: "assistant" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p1", messageID: "m1", type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "app/layouts/AppShell.tsx" }, output: "@@ +Hello World" } } } });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "edit the header" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/Edited app\/layouts\/AppShell\.tsx/)).toBeInTheDocument();
    expect(await screen.findByText(/show changes/i)).toBeInTheDocument();
    expect(screen.getByText("@@ +Hello World")).toBeInTheDocument(); // the cleaned output is present in the collapsed details
  });

  it("sends a prompt and renders streamed progress", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "message.updated", raw: { info: { id: "m1", role: "assistant" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p1", messageID: "m1", type: "text", text: "on it" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p2", messageID: "m1", type: "tool", tool: "write", state: { status: "completed", input: {} } } } });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "make it bigger" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledWith("make it bigger", expect.any(Function)));
    expect(await screen.findByText(/on it/i)).toBeInTheDocument();
    expect(await screen.findByText(/created a file/i)).toBeInTheDocument();
  });

  it("renders assistant text from message.updated + message.part.updated", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "message.updated", raw: { info: { id: "m1", role: "assistant" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p1", messageID: "m1", type: "text", text: "Here is the plan" } } });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "plan it" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/here is the plan/i)).toBeInTheDocument();
  });

  it("skips the user prompt echo (role user text parts)", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "message.updated", raw: { info: { id: "u1", role: "user" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p1", messageID: "u1", type: "text", text: "my own prompt echo" } } });
      onEvent({ type: "message.updated", raw: { info: { id: "m1", role: "assistant" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p2", messageID: "m1", type: "text", text: "assistant reply" } } });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/assistant reply/i)).toBeInTheDocument();
    expect(screen.queryByText(/my own prompt echo/i)).not.toBeInTheDocument();
  });

  it("appends streaming text deltas", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "message.updated", raw: { info: { id: "m1", role: "assistant" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p1", messageID: "m1", type: "text", text: "Hel" } } });
      onEvent({ type: "message.part.delta", raw: { messageID: "m1", partID: "p1", field: "text", delta: "lo there" } });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/hello there/i)).toBeInTheDocument();
  });

  it("renders an Allow/Deny approval card and calls respondPermission on Allow", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "permission_ask", permissionID: "perm-9", permission: "bash", patterns: ["rm -rf build"] });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "clean" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    const allow = await screen.findByRole("button", { name: /^allow$/i });
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeInTheDocument();
    fireEvent.click(allow);
    await waitFor(() => expect(apiMock.respondPermission).toHaveBeenCalledWith("perm-9", "approve"));
    expect(await screen.findByText(/allowed/i)).toBeInTheDocument();
  });

  it("renders a guardrail warning note", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "guardrail", blocked: ["src/server.ts", "Makefile"] });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/outside the UI zone were blocked/i)).toBeInTheDocument();
  });

  it("shows the cost meter from session.updated", async () => {
    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "session.updated", raw: { info: { cost: 0.1234, tokens: { input: 1200, output: 800, reasoning: 0 } } } });
      return { type: "end", code: 0 };
    });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /account and status/i }));
    expect(await screen.findByText(/\$0\.12/)).toBeInTheDocument();
    expect(screen.getByText(/2k tokens/i)).toBeInTheDocument();
  });

  it("sends with Cmd/Ctrl+Enter", async () => {
    streamPrompt.mockResolvedValue({ type: "end", code: 0 });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    const ta = screen.getByPlaceholderText(/describe a change/i);
    fireEvent.change(ta, { target: { value: "tweak the header" } });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledWith("tweak the header", expect.any(Function)));
  });

  it("plain Enter sends; Shift+Enter does not", async () => {
    streamPrompt.mockResolvedValue({ type: "end", code: 0 });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    const ta = screen.getByPlaceholderText(/describe a change/i);
    fireEvent.change(ta, { target: { value: "make a banner" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true }); // newline — must NOT send
    fireEvent.keyDown(ta, { key: "Enter" }); // plain Enter — sends
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));
    expect(streamPrompt).toHaveBeenCalledWith("make a banner", expect.any(Function));
  });

  it("on main, shows the branch and a Start a change action", async () => {
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    expect(await screen.findByText(/you're viewing the live app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start a change/i })).toBeInTheDocument();
  });

  it("on a feature branch, shows the branch name + Discard + History", async () => {
    apiMock.state.mockResolvedValue({ branch: "tweaklet/bigger", base: "main", onFeature: true, commits: [], previewing: null });
    render(<Panel />);
    expect(await screen.findByText(/tweaklet\/bigger/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /discard/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /history/i })).toBeInTheDocument();
  });

  it("Discard button appears on a feature branch and calls api.reject", async () => {
    apiMock.state.mockResolvedValue({ branch: "tweaklet/bigger", base: "main", onFeature: true, commits: [], previewing: null });
    apiMock.reject.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    const discard = await screen.findByRole("button", { name: /discard/i });
    fireEvent.click(discard);
    await waitFor(() => expect(apiMock.reject).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("always-visible revert button calls api.reject regardless of branch state", async () => {
    // Panel is on main (onFeature: false) — the Discard button is hidden, but the recovery control must still appear.
    apiMock.state.mockResolvedValue({ branch: "main", base: "main", onFeature: false, commits: [], previewing: null });
    apiMock.reject.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    const revert = await screen.findByRole("button", { name: /app not responding\? revert the last change/i });
    fireEvent.click(revert);
    await waitFor(() => expect(apiMock.reject).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("'Ready to go prod' opens a PR and shows the link", async () => {
    apiMock.createPr.mockResolvedValue({ url: "https://gh/pr/9" });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.click(screen.getByRole("button", { name: /submit for the team to review/i }));
    const link = await screen.findByRole("link", { name: /view submission/i });
    expect(link).toHaveAttribute("href", "https://gh/pr/9");
  });

  it("surfaces health checks from /api/doctor", async () => {
    apiMock.doctor.mockResolvedValue({ checks: [{ name: "opencode", status: "ok", detail: "1.17.4" }] });
    render(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: /account and status/i }));
    expect(await screen.findByText(/opencode/i)).toBeInTheDocument();
  });

  it("shows a Stop button while working and calls api.stop", async () => {
    let release: (v: any) => void = () => {};
    streamPrompt.mockImplementation(() => new Promise((r) => { release = r; }));
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    const stop = await screen.findByRole("button", { name: /^stop$/i });
    fireEvent.click(stop);
    expect(apiMock.stop).toHaveBeenCalled();
    release({ type: "end", code: 0 });
  });

  it("shows a context chip after picking an element, and clears it", async () => {
    let capturedOnPicked: ((el: any) => void) | null = null;
    pickerMocks.startPick.mockImplementation((cb) => { capturedOnPicked = cb; return () => {}; });

    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });

    fireEvent.click(screen.getByRole("button", { name: /pick an element on the page/i }));
    expect(capturedOnPicked).not.toBeNull();

    act(() => {
      capturedOnPicked!({ tag: "button", id: "go", classes: ["cta"], attrs: { type: "submit" }, selectorPath: "form#pay > button#go.cta", text: "Place order", html: "<button>" });
    });

    expect(await screen.findByText(/button#go\.cta/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear selected element/i }));
    expect(screen.queryByText(/button#go\.cta/)).toBeNull();
  });

  it("hovering a context chip calls highlightElement; leaving calls clearHighlight — no postMessage", async () => {
    const postMessageSpy = vi.spyOn(window, "postMessage");
    const parentPostMessageSpy = vi.spyOn(window.parent, "postMessage");

    let capturedOnPicked: ((el: any) => void) | null = null;
    pickerMocks.startPick.mockImplementation((cb) => { capturedOnPicked = cb; return () => {}; });

    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });

    fireEvent.click(screen.getByRole("button", { name: /pick an element on the page/i }));
    act(() => {
      capturedOnPicked!({ tag: "button", id: "go", classes: ["cta"], attrs: {}, selectorPath: "button#go.cta", text: "x", html: "<button>" });
    });

    const chip = await screen.findByText(/button#go\.cta/);

    fireEvent.mouseEnter(chip);
    expect(pickerMocks.highlightElement).toHaveBeenCalledWith("button#go.cta");

    fireEvent.mouseLeave(chip);
    expect(pickerMocks.clearHighlight).toHaveBeenCalled();

    // The critical assertion: no postMessage must have been used.
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(parentPostMessageSpy).not.toHaveBeenCalled();

    postMessageSpy.mockRestore();
    parentPostMessageSpy.mockRestore();
  });

  it("prepends the context block (route + element) to the prompt sent to the agent", async () => {
    streamPrompt.mockResolvedValue({ type: "end", code: 0 });

    let capturedOnPicked: ((el: any) => void) | null = null;
    pickerMocks.startPick.mockImplementation((cb) => { capturedOnPicked = cb; return () => {}; });

    // Set the host page URL / title that getPageContext() will read.
    Object.defineProperty(window, "location", { value: { pathname: "/checkout", search: "", href: "" }, writable: true });
    Object.defineProperty(document, "title", { value: "Checkout", writable: true });

    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });

    fireEvent.click(screen.getByRole("button", { name: /pick an element on the page/i }));
    act(() => {
      capturedOnPicked!({ tag: "button", id: "go", classes: ["cta"], attrs: { type: "submit" }, selectorPath: "form#pay > button#go.cta", text: "Place order", html: "<button>" });
    });

    await screen.findByText(/button#go\.cta/);
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "make it bigger" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));
    const sent = streamPrompt.mock.calls[0][0] as string;
    expect(sent).toContain("[Selected element] button#go.cta");
    expect(sent).toContain("make it bigger");
    expect(sent.indexOf("[Selected element]")).toBeLessThan(sent.indexOf("make it bigger"));
  });

  it("accumulates multiple picked elements and sends all of them", async () => {
    streamPrompt.mockResolvedValue({ type: "end", code: 0 });

    const onPickedCbs: Array<(el: any) => void> = [];
    pickerMocks.startPick.mockImplementation((cb) => { onPickedCbs.push(cb); return () => {}; });

    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });

    // Pick first element
    fireEvent.click(screen.getByRole("button", { name: /pick an element on the page/i }));
    act(() => {
      onPickedCbs[0]({ tag: "button", id: "go", classes: ["cta"], attrs: {}, selectorPath: "button#go.cta", text: "Go", html: "<button>" });
    });

    // Pick second element
    fireEvent.click(screen.getByRole("button", { name: /pick an element on the page/i }));
    act(() => {
      onPickedCbs[1]({ tag: "div", id: "", classes: ["card"], attrs: {}, selectorPath: "main > div.card", text: "Card", html: "<div>" });
    });

    expect(await screen.findByText(/button#go\.cta/)).toBeInTheDocument();
    expect(await screen.findByText(/div\.card/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "tweak these" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));
    const sent = streamPrompt.mock.calls[0][0] as string;
    expect(sent).toContain("[Selected element 1] button#go.cta");
    expect(sent).toContain("[Selected element 2] div.card");
  });

  it("History lists saved points and Preview calls api.preview", async () => {
    apiMock.state.mockResolvedValue({ branch: "tweaklet/x", base: "main", onFeature: true, previewing: null,
      commits: [{ sha: "s2".padEnd(40, "0"), message: "second", relativeTime: "1 min ago" },
                { sha: "s1".padEnd(40, "0"), message: "first", relativeTime: "5 min ago" }] });
    render(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: /history/i }));
    expect(await screen.findByText(/second/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(apiMock.preview).toHaveBeenCalledWith("s1".padEnd(40, "0")));
  });

  it("while previewing, shows a banner and Restore calls api.restore", async () => {
    apiMock.state.mockResolvedValue({ branch: "tweaklet/x", base: "main", onFeature: true,
      previewing: "s1".padEnd(40, "0"),
      commits: [{ sha: "s1".padEnd(40, "0"), message: "first", relativeTime: "5 min ago" }] });
    render(<Panel />);
    expect(await screen.findByText(/previewing/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe a change/i)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /restore here/i }));
    await waitFor(() => expect(apiMock.restore).toHaveBeenCalledWith("s1".padEnd(40, "0")));
  });

  it("shows repo picker when cloned=false and clicking it calls api.clone", async () => {
    apiMock.repos.mockResolvedValue({ allowlist: ["o/r"], cloned: false });

    render(<Panel />);

    // The repo chip should appear
    const chip = await screen.findByRole("button", { name: "o/r" });
    expect(chip).toBeInTheDocument();

    fireEvent.click(chip);
    await waitFor(() => expect(apiMock.clone).toHaveBeenCalledWith("o/r"));
  });

  it("removing a chip calls clearHighlight", async () => {
    let capturedOnPicked: ((el: any) => void) | null = null;
    pickerMocks.startPick.mockImplementation((cb) => { capturedOnPicked = cb; return () => {}; });

    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });

    fireEvent.click(screen.getByRole("button", { name: /pick an element on the page/i }));
    act(() => {
      capturedOnPicked!({ tag: "div", id: "box", classes: [], attrs: {}, selectorPath: "div#box", text: "", html: "<div>" });
    });

    await screen.findByText(/div#box/);
    fireEvent.click(screen.getByRole("button", { name: /clear selected element/i }));
    expect(pickerMocks.clearHighlight).toHaveBeenCalled();
    expect(screen.queryByText(/div#box/)).toBeNull();
  });

  it("re-hydrates the activity log from /agent/history on mount", async () => {
    apiMock.history.mockResolvedValue({
      events: [
        { type: "message", role: "user", text: "add hello world" },
        { type: "message", role: "assistant", text: "Done." },
      ],
      sessionId: "ses_1",
    });

    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });

    expect(await screen.findByText("add hello world")).toBeInTheDocument();
    expect(await screen.findByText("Done.")).toBeInTheDocument();
  });

  it("does not seed history when the activity log already has rows (active conversation)", async () => {
    // Delay history resolution until AFTER the live send has committed rows.
    let resolveHistory!: (v: { events: any[]; sessionId?: string }) => void;
    apiMock.history.mockReturnValue(new Promise<{ events: any[]; sessionId?: string }>((r) => { resolveHistory = r; }));

    streamPrompt.mockImplementation(async (_p: string, onEvent: (e: any) => void) => {
      onEvent({ type: "message.updated", raw: { info: { id: "m1", role: "assistant" } } });
      onEvent({ type: "message.part.updated", raw: { part: { id: "p1", messageID: "m1", type: "text", text: "live reply" } } });
      return { type: "end", code: 0 };
    });

    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });

    // Send a prompt so rows is non-empty.
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "live prompt" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    // Wait for the live reply to be in the DOM (rows is non-empty).
    expect(await screen.findByText(/live reply/i)).toBeInTheDocument();

    // Now resolve history with stale events — rows.length > 0 so they must be ignored.
    act(() => {
      resolveHistory({ events: [{ type: "message", role: "assistant", text: "from history" }] });
    });

    // History event text must NOT appear — rows was already populated.
    expect(screen.queryByText(/from history/i)).not.toBeInTheDocument();
  });
});
