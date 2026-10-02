import { randomUUID } from "node:crypto";

export interface DomResult {
  exists: boolean;
  /** Set by the widget when it refused the selector (e.g. `<head>`, scripts). */
  refused?: string;
  outerHTML?: string;
  text?: string;
  computedStyle?: Record<string, string>;
}

type Ctx = { send: (e: unknown) => void; pending: Map<string, (r: DomResult) => void> };

// One agent turn runs at a time (the server refuses a second prompt), so there is
// one active widget → one live page. The active prompt's SSE `send` + a
// per-prompt pending map are set for the turn's duration by /agent/prompt; the
// MCP tool handler calls requestDomInspect; the widget answers via
// resolveDomInspect.
let active: Ctx | null = null;
export function setActivePrompt(ctx: Ctx | null): void { active = ctx; }

/** Upper bound on a result handed to the model (JSON-encoded). */
export const MAX_RESULT_JSON = 20_000;
const MAX_STYLE_KEYS = 32;

export async function requestDomInspect(selector: string, opts: { timeoutMs?: number } = {}): Promise<DomResult> {
  const ctx = active;
  if (!ctx) return { exists: false }; // no live widget channel
  // Unguessable, so only the widget that received this frame can answer it.
  const requestId = `dom_${randomUUID()}`;
  return await new Promise<DomResult>((resolve) => {
    const timer = setTimeout(() => { ctx.pending.delete(requestId); resolve({ exists: false }); }, opts.timeoutMs ?? 15000);
    ctx.pending.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
    ctx.send({ type: "dom_inspect", requestId, selector });
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Keep only the known fields, with the right types, within MAX_RESULT_JSON. */
function sanitizeResult(raw: Record<string, unknown>): DomResult {
  const out: DomResult = { exists: raw.exists === true };
  if (typeof raw.refused === "string") out.refused = raw.refused.slice(0, 300);
  if (typeof raw.outerHTML === "string") out.outerHTML = raw.outerHTML;
  if (typeof raw.text === "string") out.text = raw.text;
  if (isPlainObject(raw.computedStyle)) {
    const style: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.computedStyle).slice(0, MAX_STYLE_KEYS)) {
      if (typeof v === "string") style[k.slice(0, 64)] = v.slice(0, 200);
    }
    out.computedStyle = style;
  }
  // Clip the free-form strings (largest first) until the whole thing fits.
  let size = JSON.stringify(out).length;
  for (const key of ["outerHTML", "text"] as const) {
    if (size <= MAX_RESULT_JSON) break;
    const v = out[key];
    if (v === undefined) continue;
    const keep = Math.max(0, v.length - (size - MAX_RESULT_JSON) - 64);
    out[key] = v.slice(0, keep);
    size = JSON.stringify(out).length;
  }
  if (size > MAX_RESULT_JSON) return { exists: out.exists };
  return out;
}

/**
 * Hand the widget's answer to the waiting `requestDomInspect`. Returns false
 * (and leaves any pending request untouched) when there is no active prompt,
 * the id is unknown, or the result is not a plain object.
 */
export function resolveDomInspect(requestId: unknown, result: unknown): boolean {
  const ctx = active;
  if (!ctx || typeof requestId !== "string" || !isPlainObject(result)) return false;
  if (!Map.prototype.has.call(ctx.pending, requestId)) return false;
  const fn: unknown = Map.prototype.get.call(ctx.pending, requestId);
  if (typeof fn !== "function") return false;
  Map.prototype.delete.call(ctx.pending, requestId);
  (fn as (r: DomResult) => void)(sanitizeResult(result));
  return true;
}
