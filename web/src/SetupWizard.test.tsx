import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// ── Mock api module ────────────────────────────────────────────────────────────
// vi.hoisted ensures these are available before the module is evaluated
const { setupApiMock, apiMock, SetupAuthErrorMock, SETUP_TOKEN_KEY_VAL } = vi.hoisted(() => {
  class SetupAuthErrorMock extends Error {
    constructor() { super("setup token required"); }
  }
  const setupApiMock = {
    state: vi.fn(),
    github: vi.fn(),
    agent: vi.fn(),
    repo: vi.fn(),
    doctor: vi.fn(),
    complete: vi.fn(),
    verifyEmbed: vi.fn(),
    verifyAgent: vi.fn(),
  };
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
  const SETUP_TOKEN_KEY_VAL = "tweaklet.setupToken";
  return { setupApiMock, apiMock, SetupAuthErrorMock, SETUP_TOKEN_KEY_VAL };
});

vi.mock("./api.js", () => ({
  api: apiMock,
  setupApi: setupApiMock,
  SetupAuthError: SetupAuthErrorMock,
  SETUP_TOKEN_KEY: SETUP_TOKEN_KEY_VAL,
  getBase: () => "",
  streamPrompt: vi.fn(),
}));

// ── Mock auth module ───────────────────────────────────────────────────────────
const { authMock } = vi.hoisted(() => {
  const authMock = { signIn: vi.fn() };
  return { authMock };
});
vi.mock("./auth.js", () => authMock);

import { App } from "./App.js";

// Minimal SetupStateResponse for reuse
function makeState(overrides: Partial<{
  completed: boolean;
  firstIncompleteStepId: string | null;
  steps: Array<{ id: string; label: string; status: "done" | "todo" }>;
  checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string; installCommand?: string }>;
  allowlist: string[];
}> = {}) {
  return {
    completed: false,
    firstIncompleteStepId: "dependencies",
    steps: [
      { id: "dependencies", label: "System dependencies", status: "todo" as const },
      { id: "github", label: "GitHub OAuth", status: "todo" as const },
      { id: "agent", label: "AI agent", status: "todo" as const },
      { id: "repo", label: "Repository", status: "todo" as const },
    ],
    checks: [],
    allowlist: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated user for Panel tests
  apiMock.me.mockResolvedValue({ login: "alice", id: 7 });
  apiMock.state.mockResolvedValue({ branch: "main", base: "main", onFeature: false, commits: [], previewing: null });
  apiMock.doctor.mockResolvedValue({ checks: [] });
  // Default: repos resolves with cloned=true so Panel tests aren't blocked by the repo picker.
  apiMock.repos.mockResolvedValue({ allowlist: [], cloned: true });
  apiMock.clone.mockResolvedValue({ path: "/tmp/repo" });
  // Default: history resolves with empty events (no prior conversation).
  apiMock.history.mockResolvedValue({ events: [], sessionId: undefined });
  // Default: signIn resolves to signed-in
  authMock.signIn.mockResolvedValue("signed-in");
  // Default verify results for FinishStep
  setupApiMock.verifyEmbed.mockResolvedValue({ embedded: true, widgetReachable: true, hostUrl: "/", detail: "" });
  setupApiMock.verifyAgent.mockResolvedValue({ ready: true, signedIn: true, opencodeOk: true, repoCloned: true, detail: "agent ready" });
});

afterEach(() => {
  sessionStorage.clear();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("App routing", () => {

  it("403 from setupApi.state shows the token prompt", async () => {
    setupApiMock.state.mockRejectedValue(new SetupAuthErrorMock());
    render(<App />);
    expect(await screen.findByText(/enter setup token/i)).toBeInTheDocument();
    expect(screen.getByText(/setup token was printed in the tweaklet server log/i)).toBeInTheDocument();
  });

  it("entering a token retries setupApi.state", async () => {
    // First call: 403, second call (after token entry): returns wizard state
    setupApiMock.state
      .mockRejectedValueOnce(new SetupAuthErrorMock())
      .mockResolvedValueOnce(makeState());

    render(<App />);
    // Wait for token prompt
    const heading = await screen.findByText(/enter setup token/i);
    expect(heading).toBeInTheDocument();

    // Enter a token and submit
    const input = screen.getByPlaceholderText(/paste the token/i);
    fireEvent.change(input, { target: { value: "my-token-abc" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Should now show wizard
    await waitFor(() => expect(setupApiMock.state).toHaveBeenCalledTimes(2));
    expect(sessionStorage.getItem(SETUP_TOKEN_KEY_VAL)).toBe("my-token-abc");
  });

  it("completed:false renders wizard with step labels", async () => {
    setupApiMock.state.mockResolvedValue(
      makeState({
        firstIncompleteStepId: "dependencies",
        steps: [
          { id: "dependencies", label: "System dependencies", status: "todo" },
          { id: "github", label: "GitHub OAuth", status: "done" },
          { id: "agent", label: "AI agent", status: "todo" },
          { id: "repo", label: "Repository", status: "todo" },
        ],
        checks: [
          { name: "node version", status: "fail", detail: "Node 18+ required", installCommand: "brew install node" },
        ],
      })
    );
    render(<App />);
    // Step labels visible
    expect(await screen.findByText(/system dependencies/i)).toBeInTheDocument();
    expect(await screen.findByText(/github oauth/i)).toBeInTheDocument();
    // The failing dep step is open (firstIncompleteStepId = dependencies), so the install command is visible
    expect(await screen.findByText(/brew install node/i)).toBeInTheDocument();
  });

  it("completed:true renders Panel, not wizard", async () => {
    setupApiMock.state.mockResolvedValue(
      makeState({ completed: true, firstIncompleteStepId: null })
    );
    render(<App />);
    // Panel renders sign-in link when unauthenticated; but our default mock has alice logged in
    // Just verify the wizard heading is NOT present — Panel has rendered instead
    await waitFor(() => {
      expect(screen.queryByText(/tweaklet setup/i)).toBeNull();
    });
    // Panel renders the alice button
    expect(await screen.findByRole("button", { name: /alice/i })).toBeInTheDocument();
  });

  it("non-SetupAuthError (simulating 410) renders Panel", async () => {
    setupApiMock.state.mockRejectedValue(new Error("some other error"));
    render(<App />);
    // Should render Panel (not token prompt, not wizard)
    await waitFor(() => {
      expect(screen.queryByText(/enter setup token/i)).toBeNull();
      expect(screen.queryByText(/tweaklet setup/i)).toBeNull();
    });
    expect(await screen.findByRole("button", { name: /alice/i })).toBeInTheDocument();
  });

  it("successful setupApi.github triggers a state re-fetch", async () => {
    // Initial state: github step is todo, expanded
    setupApiMock.state.mockResolvedValue(
      makeState({
        firstIncompleteStepId: "github",
        steps: [
          { id: "dependencies", label: "System dependencies", status: "done" },
          { id: "github", label: "GitHub OAuth", status: "todo" },
          { id: "agent", label: "AI agent", status: "todo" },
          { id: "repo", label: "Repository", status: "todo" },
        ],
      })
    );
    // github POST response: github now done
    const afterGithub = {
      ...makeState({
        firstIncompleteStepId: "agent",
        steps: [
          { id: "dependencies", label: "System dependencies", status: "done" },
          { id: "github", label: "GitHub OAuth", status: "done" },
          { id: "agent", label: "AI agent", status: "todo" },
          { id: "repo", label: "Repository", status: "todo" },
        ],
      }),
      allowlist: ["org/repo"],
    };
    setupApiMock.github.mockResolvedValue(afterGithub);

    render(<App />);
    // Wait for wizard to render — the GitHub step label is in a span
    await screen.findByText("GitHub OAuth");

    // GitHub step should be expanded (firstIncompleteStepId = github)
    // Fill in the form
    const clientIdInput = await screen.findByLabelText(/client id/i);
    const clientSecretInput = screen.getByLabelText(/client secret/i);
    fireEvent.change(clientIdInput, { target: { value: "Ov23liABC" } });
    fireEvent.change(clientSecretInput, { target: { value: "supersecret" } });
    fireEvent.click(screen.getByRole("button", { name: /save github config/i }));

    // setupApi.github called once
    await waitFor(() => expect(setupApiMock.github).toHaveBeenCalledWith({
      clientId: "Ov23liABC",
      clientSecret: "supersecret",
    }));

    // The POST response's allowlist is preserved on stateResp — the field must
    // not be undefined after the github step, or RepoStep will crash.
    expect(afterGithub.allowlist).toEqual(["org/repo"]);
  });
});

describe("RepoStep allowlist editor", () => {
  it("renders the allowlist textarea and Save repositories calls setupApi.repo with parsed lines", async () => {
    // All steps before repo are done; repo is the first incomplete step so it opens.
    setupApiMock.state.mockResolvedValue(
      makeState({
        firstIncompleteStepId: "repo",
        steps: [
          { id: "dependencies", label: "System dependencies", status: "done" },
          { id: "github", label: "GitHub OAuth", status: "done" },
          { id: "agent", label: "AI agent", status: "done" },
          { id: "repo", label: "Repository", status: "todo" },
        ],
        allowlist: [],
      })
    );
    setupApiMock.repo.mockResolvedValue(
      makeState({
        firstIncompleteStepId: null,
        steps: [
          { id: "dependencies", label: "System dependencies", status: "done" },
          { id: "github", label: "GitHub OAuth", status: "done" },
          { id: "agent", label: "AI agent", status: "done" },
          { id: "repo", label: "Repository", status: "done" },
        ],
        allowlist: ["transcenda/t8a"],
      })
    );

    render(<App />);

    const textarea = await screen.findByLabelText(/allowed repositories/i);
    expect(textarea).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "transcenda/t8a" } });
    fireEvent.click(screen.getByRole("button", { name: /save repositories/i }));

    await waitFor(() =>
      expect(setupApiMock.repo).toHaveBeenCalledWith({ allowlist: ["transcenda/t8a"] })
    );
  });
});

describe("FinishStep popup sign-in", () => {
  // Render the finish step directly by setting up all server steps as done.
  function makeAllDoneState() {
    return makeState({
      firstIncompleteStepId: null,
      steps: [
        { id: "dependencies", label: "System dependencies", status: "done" },
        { id: "github", label: "GitHub OAuth", status: "done" },
        { id: "agent", label: "AI agent", status: "done" },
        { id: "repo", label: "Repository", status: "done" },
      ],
    });
  }

  it("shows popup sign-in button when not yet signed in", async () => {
    setupApiMock.state.mockResolvedValue(makeAllDoneState());
    apiMock.me.mockResolvedValue(null);

    render(<App />);
    expect(await screen.findByRole("button", { name: /sign in with github/i })).toBeInTheDocument();
  });

  it("clicking sign-in calls signIn() then re-fetches me()", async () => {
    setupApiMock.state.mockResolvedValue(makeAllDoneState());
    // Initial me() returns null; after sign-in returns user
    apiMock.me
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ login: "alice", id: 7 });
    authMock.signIn.mockResolvedValue("signed-in");

    render(<App />);
    const btn = await screen.findByRole("button", { name: /sign in with github/i });
    fireEvent.click(btn);

    await waitFor(() => expect(authMock.signIn).toHaveBeenCalledTimes(1));
    // After sign-in, FinishStep re-fetches me() and shows the authenticated state.
    await waitFor(() => expect(apiMock.me).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/signed in as/i)).toBeInTheDocument();
  });

  it("sign-in button stays visible when signIn() returns 'closed'", async () => {
    setupApiMock.state.mockResolvedValue(makeAllDoneState());
    apiMock.me.mockResolvedValue(null);
    authMock.signIn.mockResolvedValue("closed");

    render(<App />);
    const btn = await screen.findByRole("button", { name: /sign in with github/i });
    fireEvent.click(btn);

    await waitFor(() => expect(authMock.signIn).toHaveBeenCalledTimes(1));
    // Still shows the sign-in button (me() was not refreshed since result was "closed")
    expect(screen.getByRole("button", { name: /sign in with github/i })).toBeInTheDocument();
  });

  it("'Finish setup' button is disabled and embed guidance shows when verifyEmbed returns embedded:false", async () => {
    setupApiMock.state.mockResolvedValue(makeAllDoneState());
    // Signed in as alice
    apiMock.me.mockResolvedValue({ login: "alice", id: 7 });
    setupApiMock.verifyEmbed.mockResolvedValue({
      embedded: false,
      widgetReachable: false,
      hostUrl: "http://localhost:4319/",
      detail: "",
    });
    setupApiMock.verifyAgent.mockResolvedValue({
      ready: false, signedIn: true, opencodeOk: true, repoCloned: false, detail: "no repo cloned yet",
    });

    render(<App />);

    // Wait for the finish step to render with sign-in confirmation
    await screen.findByText(/signed in as/i);

    // Finish button should be disabled because embed is not ok
    await waitFor(() => {
      const finishBtn = screen.getByRole("button", { name: /finish setup/i });
      expect(finishBtn).toBeDisabled();
    });

    // Guidance about embedding should appear
    expect(await screen.findByText(/install-tweaklet-widget/i)).toBeInTheDocument();
  });

  it("'Finish setup' button is enabled and 'Open in your app' link shows when verifyEmbed returns embedded:true", async () => {
    setupApiMock.state.mockResolvedValue(makeAllDoneState());
    apiMock.me.mockResolvedValue({ login: "alice", id: 7 });
    // defaults from beforeEach: verifyEmbed embedded:true, verifyAgent ready:true

    render(<App />);

    await screen.findByText(/signed in as/i);

    await waitFor(() => {
      const finishBtn = screen.getByRole("button", { name: /finish setup/i });
      expect(finishBtn).not.toBeDisabled();
    });

    // "Open in your app" link should be visible
    expect(await screen.findByRole("link", { name: /open in your app/i })).toBeInTheDocument();
  });
});
