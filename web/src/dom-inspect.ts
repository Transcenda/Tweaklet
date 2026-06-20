export interface DomResult {
  exists: boolean;
  outerHTML?: string;
  text?: string;
  computedStyle?: Record<string, string>;
}

const STYLE_KEYS = ["display", "color", "fontSize", "fontWeight", "marginLeft", "backgroundColor"] as const;

/** Read the live host DOM for a selector. Runs in the host page (the widget is
 *  NOT in an iframe), so `document` is the user's actual page. Caps sizes so a
 *  huge subtree can't blow up the round-trip payload. */
export function inspectDom(selector: string, doc: Document = document): DomResult {
  let el: Element | null = null;
  try { el = doc.querySelector(selector); } catch { return { exists: false }; } // invalid selector
  if (!el) return { exists: false };
  const cs = (typeof getComputedStyle === "function") ? getComputedStyle(el as Element) : null;
  const computedStyle: Record<string, string> = {};
  if (cs) for (const k of STYLE_KEYS) computedStyle[k] = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())) || (cs as any)[k] || "";
  return {
    exists: true,
    outerHTML: (el as Element).outerHTML.slice(0, 4000),
    text: ((el as Element).textContent ?? "").trim().slice(0, 2000),
    computedStyle,
  };
}
