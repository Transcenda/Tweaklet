import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { setupApiMock, SetupAuthErrorMock } = vi.hoisted(() => {
  class SetupAuthErrorMock extends Error {
    constructor() { super("setup token required"); }
  }
  return { setupApiMock: { state: vi.fn() }, SetupAuthErrorMock };
});

vi.mock("./api.js", () => ({
  setupApi: setupApiMock,
  SetupAuthError: SetupAuthErrorMock,
  SETUP_TOKEN_KEY: "tweaklet.setupToken",
  getBase: () => "https://app.example.com/tweaklet",
}));
vi.mock("./SetupWizard.js", () => ({ SetupWizard: () => <div>setup wizard</div> }));
vi.mock("./Panel.js", () => ({ Panel: () => <div>agent panel</div> }));

import { App } from "./App.js";

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { sessionStorage.clear(); });

describe("App on an embedded host page", () => {
  it("never asks for the setup token; points to the setup page instead", async () => {
    setupApiMock.state.mockRejectedValue(new SetupAuthErrorMock());
    render(<App />);
    expect(await screen.findByText(/isn't set up yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/enter setup token/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/paste the token/i)).toBeNull();
    const link = screen.getByRole("link", { name: /tweaklet\/$/i });
    expect(link).toHaveAttribute("href", "https://app.example.com/tweaklet/");
  });

  it("does not show the setup wizard when setup is incomplete", async () => {
    setupApiMock.state.mockResolvedValue({ completed: false });
    render(<App />);
    expect(await screen.findByText(/isn't set up yet/i)).toBeInTheDocument();
    expect(screen.queryByText("setup wizard")).toBeNull();
  });

  it("shows the panel once setup is complete (zero-config path unchanged)", async () => {
    setupApiMock.state.mockResolvedValue({ completed: true });
    render(<App />);
    expect(await screen.findByText("agent panel")).toBeInTheDocument();
  });
});

describe("App in standalone mode (the setup page)", () => {
  it("shows the token prompt on 403", async () => {
    setupApiMock.state.mockRejectedValue(new SetupAuthErrorMock());
    render(<App standalone />);
    expect(await screen.findByText(/enter setup token/i)).toBeInTheDocument();
  });

  it("shows the setup wizard when setup is incomplete", async () => {
    setupApiMock.state.mockResolvedValue({ completed: false });
    render(<App standalone />);
    await waitFor(() => expect(screen.getByText("setup wizard")).toBeInTheDocument());
  });
});
