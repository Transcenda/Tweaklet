export interface PickedElement {
  tag: string;
  id: string;
  classes: string[];
  attrs: Record<string, string>;
  selectorPath: string;
  text: string;
  html: string;
}
export interface PageContext { route: string; title: string; }

const KEEP_ATTRS = ["role", "name", "type", "href", "alt", "placeholder", "title"];

/** Serialize a DOM element to agent-useful metadata (no page data/secrets). */
export function serializeElement(el: Element): PickedElement {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (a.name === "class" || a.name === "id" || a.name === "style") continue;
    if (a.name.startsWith("data-") || a.name.startsWith("aria-") || KEEP_ATTRS.includes(a.name)) {
      attrs[a.name] = a.value;
    }
  }
  const path: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && cur.tagName.toLowerCase() !== "body" && depth < 5; depth++) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) seg += "#" + cur.id;
    if (cur.classList.length) seg += "." + Array.from(cur.classList).join(".");
    path.unshift(seg);
    cur = cur.parentElement;
  }
  const open = el.outerHTML.match(/^<[^>]*>/);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    classes: Array.from(el.classList),
    attrs,
    selectorPath: path.join(" > "),
    text: (el.textContent || "").trim().slice(0, 120),
    html: open ? open[0] : "",
  };
}

/** Build the context block prepended to the agent prompt. Empty string if nothing known. */
export function formatContext(page: PageContext | null, elements: PickedElement[]): string {
  const lines: string[] = [];
  if (page) lines.push(`[Page] route: ${page.route} · title: ${JSON.stringify(page.title)}`);
  elements.forEach((element, i) => {
    const head = element.tag + (element.id ? "#" + element.id : "") + (element.classes.length ? "." + element.classes.join(".") : "");
    lines.push(`[Selected element${elements.length > 1 ? " " + (i + 1) : ""}] ${head}`);
    lines.push(`  selector: ${element.selectorPath}`);
    if (element.text) lines.push(`  text: ${JSON.stringify(element.text)}`);
    const attrs = Object.entries(element.attrs).map(([k, v]) => `${k}=${v}`).join(", ");
    if (attrs) lines.push(`  attrs: ${attrs}`);
  });
  return lines.join("\n");
}
