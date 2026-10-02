export interface DomResult {
  exists: boolean;
  /** Set when the selector was refused; a short, user-readable reason. */
  refused?: string;
  outerHTML?: string;
  text?: string;
  computedStyle?: Record<string, string>;
}

const STYLE_KEYS = ["display", "color", "fontSize", "fontWeight", "marginLeft", "backgroundColor"] as const;
const MAX_HTML = 4000;
const MAX_TEXT = 2000;

// Elements that hold code, page metadata or another document rather than UI.
// Their content (inline config, CSRF metas, nonces, embedded frames) is exactly
// what must never reach the model, and none of it is needed to change the UI.
const BLOCKED_TAGS = ["head", "script", "style", "template", "noscript", "meta", "link", "iframe"];
const BLOCKED_SELECTOR = BLOCKED_TAGS.join(",");
const STRIP_SELECTOR = BLOCKED_TAGS.filter((t) => t !== "head").join(",");
// A blocked tag used as a type selector (not as part of a class/id/attribute).
const BLOCKED_TYPE_RE = new RegExp(`(^|[\\s>+~,(])(${BLOCKED_TAGS.join("|")})(?=$|[\\s>+~,.#\\[:)])`, "i");
const REFUSED_CODE = "scripts, styles, page metadata and embedded frames can't be read";
const REFUSED_DOCUMENT = "the whole document can't be read; ask for an element on the page";

const SECRET_ATTR_RE = /token|secret|csrf|xsrf|nonce|auth|password|passwd|key/i;
const OPAQUE_VALUE_RE = /^[A-Za-z0-9_\-.=+/]{24,}$/;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// Long unbroken runs that mix letters and digits: API keys, session ids, hashes.
// (Requiring both keeps long words and separator runs readable.)
const OPAQUE_TOKEN_RE = /[A-Za-z0-9_\-+/=]{32,}/g;
const REDACTED = "[redacted]";
// Attribute values the agent needs verbatim to write selectors and styles.
const VERBATIM_ATTRS = new Set(["class", "id", "role"]);

/** Replace JWTs and long opaque tokens in free text with a placeholder. */
export function redactText(s: string): string {
  return s
    .replace(JWT_RE, REDACTED)
    .replace(OPAQUE_TOKEN_RE, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? REDACTED : m));
}

function stripSelectorStrings(selector: string): string {
  // Drop quoted strings and attribute brackets so `[title="head"]` isn't read as a tag.
  return selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "").replace(/\[[^\]]*\]/g, "[]");
}

function refusal(reason: string): DomResult {
  return { exists: false, refused: reason };
}

/** Whether an attribute is dropped outright (secret-named, inline handler, opaque data-*). */
export function isSecretAttribute(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("aria-") || VERBATIM_ATTRS.has(n)) return false;
  return SECRET_ATTR_RE.test(n) || n.startsWith("on") || (n.startsWith("data-") && OPAQUE_VALUE_RE.test(value));
}

function redactAttributes(el: Element): void {
  for (const a of Array.from(el.attributes)) {
    const name = a.name.toLowerCase();
    if (name.startsWith("aria-") || VERBATIM_ATTRS.has(name)) continue;
    if (isSecretAttribute(name, a.value)) { el.removeAttribute(a.name); continue; }
    const v = redactText(a.value);
    if (v !== a.value) el.setAttribute(a.name, v);
  }
}

/** Clone `el` and scrub everything the agent doesn't need and the page owner wouldn't share. */
export function redactedClone(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(STRIP_SELECTOR).forEach((n) => n.remove());
  const nodes = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    if (tag === "input") {
      const type = (node.getAttribute("type") ?? "").toLowerCase();
      const sensitive = type === "hidden" || type === "password";
      if (sensitive && node !== clone) { node.remove(); continue; }
      if (sensitive) node.removeAttribute("type");
      node.removeAttribute("value");
      // A clone carries the live typed value; reset it so nothing can read it later.
      (node as HTMLInputElement).value = "";
    } else if (tag === "textarea") {
      node.removeAttribute("value");
      node.textContent = "";
    } else if (tag === "select") {
      node.removeAttribute("value");
    }
    redactAttributes(node);
  }
  // Text nodes carry the visible copy (kept) and sometimes rendered tokens
  // (redacted); comments are developer notes, never UI, so they go.
  const doc = clone.ownerDocument;
  const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.COMMENT_NODE) { comments.push(n); continue; }
    const v = redactText(n.nodeValue ?? "");
    if (v !== n.nodeValue) n.nodeValue = v;
  }
  comments.forEach((c) => c.parentNode?.removeChild(c));
  return clone;
}

/** Read the live host DOM for a selector. Runs in the host page (the widget is
 *  NOT in an iframe), so `document` is the user's actual page. The result is
 *  sent to an LLM, so the query is scoped to `<body>`, refuses code/metadata
 *  elements, and the returned HTML/text come from a redacted clone. Caps sizes
 *  so a huge subtree can't blow up the round-trip payload. */
export function inspectDom(selector: string, doc: Document = document): DomResult {
  const body = doc.body;
  if (!body || typeof selector !== "string" || !selector.trim()) return { exists: false };
  try { doc.documentElement.matches(selector); } catch { return { exists: false }; } // invalid selector

  if (/:root\b/i.test(selector)) return refusal(REFUSED_DOCUMENT);
  if (BLOCKED_TYPE_RE.test(stripSelectorStrings(selector))) return refusal(REFUSED_CODE);

  const el = body.matches(selector) ? body : body.querySelector(selector);
  if (!el) {
    if (doc.documentElement.matches(selector)) return refusal(REFUSED_DOCUMENT);
    if (doc.head && (doc.head.matches(selector) || doc.head.querySelector(selector))) return refusal(REFUSED_CODE);
    return { exists: false };
  }
  if (el.closest(BLOCKED_SELECTOR)) return refusal(REFUSED_CODE);

  const cs = (typeof getComputedStyle === "function") ? getComputedStyle(el) : null;
  const computedStyle: Record<string, string> = {};
  if (cs) for (const k of STYLE_KEYS) computedStyle[k] = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())) || (cs as any)[k] || "";
  const clone = redactedClone(el);
  return {
    exists: true,
    outerHTML: clone.outerHTML.slice(0, MAX_HTML),
    text: redactText((clone.textContent ?? "").trim()).slice(0, MAX_TEXT),
    computedStyle,
  };
}
