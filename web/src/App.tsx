import { useState, useEffect } from "react";
import { Panel } from "./Panel.js";
import { SetupWizard } from "./SetupWizard.js";
import { setupApi, SetupAuthError, SETUP_TOKEN_KEY, getBase } from "./api.js";

type AppMode = "loading" | "token-prompt" | "wizard" | "not-set-up" | "panel";

interface AppProps {
  // When loaded on the bare bootstrap page (…/widget.js?standalone=1) there is
  // no host app to float over, so the UI renders as a centered full-page card
  // (and starts open) instead of the collapsed edge launcher + slide-in dock.
  standalone?: boolean;
}

export function App({ standalone = false }: AppProps = {}) {
  const [mode, setMode] = useState<AppMode>("loading");
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState("");
  // The widget now mounts itself into the host page (no iframe). When embedded
  // it renders a floating launcher; the panel slides in when open. In standalone
  // setup mode the launcher is replaced by a centered card (always open).
  const [open, setOpen] = useState(false);

  // Setup (and its token) only ever happens on Tweaklet's own setup page
  // (standalone). On a host app's page the token would be typed into, and kept
  // in the sessionStorage of, an origin full of someone else's scripts, so an
  // embedded widget just points at the setup page instead.
  async function checkState() {
    try {
      const state = await setupApi.state();
      setMode(state.completed ? "panel" : standalone ? "wizard" : "not-set-up");
    } catch (e) {
      if (e instanceof SetupAuthError) {
        setMode(standalone ? "token-prompt" : "not-set-up");
      } else {
        // Any other error (including 410 = already completed) → Panel
        setMode("panel");
      }
    }
  }

  useEffect(() => { void checkState(); }, []);

  // Dock mode: when the panel is open, mark the host <html> so the injected
  // dock stylesheet (see embed.tsx) shrinks <body> to the left and reserves the
  // right column for the panel — the app reflows beside it instead of being
  // overlaid, so you can watch changes land while iterating. No-op in
  // standalone (no host app), and the stylesheet itself disables the shrink on
  // narrow viewports (the panel falls back to an overlay there).
  useEffect(() => {
    if (standalone) return;
    document.documentElement.classList.toggle("tweaklet-docked", open);
    return () => document.documentElement.classList.remove("tweaklet-docked");
  }, [open, standalone]);

  function inner() {
    if (mode === "loading") {
      return (
        <div className="apz">
          <div className="apz-auth">
            <div className="apz-mark" />
            <p>Loading…</p>
          </div>
        </div>
      );
    }

    if (mode === "not-set-up" || (!standalone && (mode === "token-prompt" || mode === "wizard"))) {
      const setupUrl = `${getBase()}/`;
      return (
        <div className="apz">
          <div className="apz-token-prompt" role="status">
            <div className="apz-mark" />
            <h1>Tweaklet isn't set up yet</h1>
            <p>
              Open <a href={setupUrl} target="_blank" rel="noopener noreferrer">{setupUrl}</a> to finish setup, then reload this page.
            </p>
          </div>
        </div>
      );
    }

    if (mode === "token-prompt") {
      async function submitToken(e: React.FormEvent) {
        e.preventDefault();
        if (!tokenInput.trim()) return;
        sessionStorage.setItem(SETUP_TOKEN_KEY, tokenInput.trim());
        setTokenError("");
        try {
          const state = await setupApi.state();
          setMode(state.completed ? "panel" : "wizard");
        } catch (err) {
          if (err instanceof SetupAuthError) {
            setTokenError("Invalid token — please check the server log and try again.");
          } else {
            setMode("panel");
          }
        }
      }

      return (
        <div className="apz">
          <div className="apz-token-prompt">
            <div className="apz-mark" />
            <h1>Enter setup token</h1>
            <p>The setup token was printed in the Tweaklet server log on startup.</p>
            <form onSubmit={submitToken}>
              <input
                className="apz-token-input"
                type="text"
                placeholder="Paste the token from the server log"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                autoFocus
              />
              {tokenError && <div className="apz-setup-error">{tokenError}</div>}
              <button className="apz-btn apz-btn--primary" type="submit" style={{ width: "100%" }}>
                Continue
              </button>
            </form>
          </div>
        </div>
      );
    }

    if (mode === "wizard") {
      return <SetupWizard onComplete={() => setMode("panel")} />;
    }

    return <Panel />;
  }

  // Standalone (bootstrap/setup page): centered full-page card, always open, no
  // launcher — there's no host app to peek at behind it.
  if (standalone) {
    return (
      <div className="apz-standalone">
        <div className="apz-standalone-card" role="dialog" aria-label="Tweaklet setup">
          {inner()}
        </div>
      </div>
    );
  }

  // Embedded: floating edge launcher + slide-in dock over the host app.
  return (
    <>
      <button
        type="button"
        className={`apz-launcher${open ? " is-open" : ""}`}
        aria-label={open ? "Collapse Tweaklet panel" : "Open Tweaklet panel"}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "›" : "‹"}
      </button>
      <div className={`apz-dock${open ? " is-open" : ""}`} role="dialog" aria-label="Tweaklet">
        {inner()}
      </div>
    </>
  );
}
