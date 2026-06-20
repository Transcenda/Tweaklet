/**
 * Host-DOM element picker.
 *
 * Runs entirely inside the host page (no postMessage, no iframe). The panel
 * lives in a Shadow root under #tweaklet-root, so we explicitly skip any
 * element inside that host node to prevent picking the widget itself.
 */

import { serializeElement, type PickedElement } from "./contextCapture.js";

const TWEAKLET_ROOT_ID = "tweaklet-root";
const OVERLAY_ID = "__tweaklet_picker_overlay__";

// ── Overlay helpers ──────────────────────────────────────────────────────────

function getOrCreateOverlay(): HTMLDivElement {
  let el = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    Object.assign(el.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483646",
      boxSizing: "border-box",
      outline: "2px solid #6366f1",
      outlineOffset: "1px",
      borderRadius: "2px",
      background: "rgba(99,102,241,0.08)",
      transition: "all 0.05s ease",
    });
    document.body.appendChild(el);
  }
  return el;
}

function positionOverlay(overlay: HTMLDivElement, el: Element): void {
  const r = el.getBoundingClientRect();
  Object.assign(overlay.style, {
    top: r.top + "px",
    left: r.left + "px",
    width: r.width + "px",
    height: r.height + "px",
    display: "block",
  });
}

function hideOverlay(): void {
  const el = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (el) el.style.display = "none";
}

function removeOverlay(): void {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}

// ── Guard ────────────────────────────────────────────────────────────────────

/** Returns true if `el` is inside the Tweaklet shadow host — not pickable. */
function isInsideTweakletRoot(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  const root = document.getElementById(TWEAKLET_ROOT_ID);
  if (!root) return false;
  // el could be inside the Shadow DOM, so we also check the shadow root's host
  return root.contains(el) || el === root;
}

// ── startPick ────────────────────────────────────────────────────────────────

export interface PickOptions {
  /** Extra elements to skip in addition to the widget root (e.g. the overlay itself). */
  skip?: Element[];
}

/**
 * Begin element-pick mode on the host page.
 *
 * - Draws a hover overlay on mousemove (skips the Tweaklet root).
 * - Capture-phase click → serializes the element, calls onPicked, stops picking.
 * - Esc → cancels, calls cleanup.
 *
 * Returns a cleanup function that removes all listeners + the overlay.
 */
export function startPick(
  onPicked: (el: PickedElement) => void,
  _opts?: PickOptions,
): () => void {
  const overlay = getOrCreateOverlay();

  function onMouseMove(e: MouseEvent): void {
    const target = e.target as Element | null;
    if (!target || isInsideTweakletRoot(target) || target === overlay) {
      hideOverlay();
      return;
    }
    positionOverlay(overlay, target);
  }

  function onClick(e: MouseEvent): void {
    const target = e.target as Element | null;
    if (!target || isInsideTweakletRoot(target) || target === overlay) return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
    onPicked(serializeElement(target));
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
    }
  }

  function cleanup(): void {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    removeOverlay();
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("click", onClick, true); // capture so we can preventDefault
  document.addEventListener("keydown", onKeyDown, true);

  return cleanup;
}

// ── highlightElement / clearHighlight ────────────────────────────────────────

/**
 * Draw the hover outline over a host element by direct reference or by CSS
 * selector path (the `selectorPath` from a `PickedElement`).
 * No-ops silently if the element cannot be found.
 */
export function highlightElement(selectorOrEl: string | Element): void {
  const el =
    typeof selectorOrEl === "string"
      ? (document.querySelector(selectorOrEl) as Element | null)
      : selectorOrEl;
  if (!el) return;
  const overlay = getOrCreateOverlay();
  positionOverlay(overlay, el);
}

/**
 * Remove the highlight overlay from the page.
 */
export function clearHighlight(): void {
  removeOverlay();
}
