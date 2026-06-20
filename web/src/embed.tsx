// Self-mounting Shadow-DOM widget entry (Intercom-style).
//
// This module is the library bundle's entry point (vite build.lib → dist/widget.js).
// On load it derives its own base from the <script src=".../widget.js"> URL,
// then renders the React app into an open Shadow root appended to the host
// <body>. There is NO iframe and NO postMessage bridge — the app lives in the
// host document's context (a sibling shadow tree), and styles are isolated by
// injecting the bundled CSS string into the shadow root.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Vite returns the contents of panel.css as a string with the ?inline query.
import cssText from "./panel.css?inline";
import { App } from "./App.js";
import { setBase } from "./api.js";

const ROOT_ID = "tweaklet-root";

/**
 * Derive the widget base (origin + path prefix, no trailing slash) from the
 * URL of the script that loaded us, e.g.
 *   https://host/tweaklet/widget.js        → https://host/tweaklet
 *   https://host/tweaklet/widget.js?v=2    → https://host/tweaklet
 *   https://host/widget.js                 → https://host
 * Exported for unit testing.
 */
export function deriveBase(src: string | null | undefined): string {
  if (!src) return "";
  return src.replace(/\/widget\.js(\?.*)?$/, "");
}

/**
 * Whether the widget was loaded in standalone (bootstrap/setup-page) mode,
 * signalled by `?standalone=1` (or a bare `?standalone`) on the script src.
 * In standalone mode there is no host app, so the UI renders as a centered card.
 * Exported for unit testing.
 */
export function isStandalone(src: string | null | undefined): boolean {
  if (!src) return false;
  const q = src.indexOf("?");
  if (q < 0) return false;
  return new URLSearchParams(src.slice(q + 1)).has("standalone");
}

/** Locate this script's src: prefer document.currentScript, fall back to scanning. */
function findScriptSrc(): string {
  const current = document.currentScript as HTMLScriptElement | null;
  if (current?.src) return current.src;
  const scripts = Array.from(document.scripts);
  const match = scripts.find((s) => /\/widget\.js(\?.*)?$/.test(s.src));
  return match?.src ?? "";
}

/**
 * Mount the widget into a Shadow root on the host page.
 * Idempotent: a second call is a no-op if #tweaklet-root already exists.
 * Exported for unit testing (pass a known `src`).
 */
export function mount(src: string): void {
  if (document.getElementById(ROOT_ID)) return;
  setBase(deriveBase(src));
  const standalone = isStandalone(src);

  const host = document.createElement("div");
  host.id = ROOT_ID;
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = cssText;
  shadow.appendChild(style);

  const mountPoint = document.createElement("div");
  mountPoint.className = standalone ? "tweaklet-shadow-mount tweaklet-standalone-root" : "tweaklet-shadow-mount";
  shadow.appendChild(mountPoint);

  createRoot(mountPoint).render(
    <StrictMode>
      <App standalone={standalone} />
    </StrictMode>,
  );
}

// Capture currentScript at module-evaluation time (it is null inside async
// callbacks), then mount. We only auto-mount when we can identify our own
// <script src=".../widget.js"> — a real embed always has one. When the module
// is imported without such a script (e.g. unit tests), auto-mount is skipped
// and callers drive mount() / deriveBase() directly.
const scriptSrc = findScriptSrc();
if (scriptSrc && typeof document !== "undefined") {
  if (document.body) mount(scriptSrc);
  else document.addEventListener("DOMContentLoaded", () => mount(scriptSrc));
}
