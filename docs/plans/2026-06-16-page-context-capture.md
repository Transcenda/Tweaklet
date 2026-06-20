# Tweaklet Page-Context Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick an element on the running app (devtools-style) so the agent receives that element + its HTML hierarchy + the page route, attached to the prompt — so it can locate the source by class/selector/attribute.

**Architecture:** Pure, jsdom-tested `serializeElement` + `formatContext` live in `tweaklet/web/src/contextCapture.ts`. The host `snippet.js` (in `server.ts`) gains an element-picker overlay and an inline mirror of the serializer, and bridges results to the panel iframe via `postMessage`. `Panel.tsx` listens (origin/type-gated), holds page + picked-element state, shows a removable chip, and prepends the context block to the prompt string in `send()`. No backend route changes — context rides inside the existing `prompt`.

**Tech Stack:** Node/TS ESM, Express (serves the snippet string), React + Vite, Vitest (jsdom for web). Tests run with `npm --prefix web test`; web build `npm --prefix web run build`; backend build `npm run build`. Run from `tweaklet/`.

Spec: `tweaklet/docs/specs/2026-06-16-page-context-capture-design.md`.

---

## File Structure
- **Create** `tweaklet/web/src/contextCapture.ts` — `PickedElement`/`PageContext` types + pure `serializeElement(el)` and `formatContext(page, element)`.
- **Create** `tweaklet/web/src/contextCapture.test.ts` — jsdom unit tests.
- **Modify** `tweaklet/src/server/server.ts` (`/snippet.js`) — picker overlay + inline serializer mirror + `postMessage` bridge.
- **Modify** `tweaklet/web/src/Panel.tsx` — message listener, page/picked state, Pick control, chip, prompt integration.
- **Modify** `tweaklet/web/src/Panel.test.tsx` — message → chip → send tests.
- **Modify** `tweaklet/web/src/panel.css` — chip + Pick-button styles.

---

## Task 1: `serializeElement` + `formatContext` (pure, jsdom-tested)

**Files:**
- Create: `tweaklet/web/src/contextCapture.ts`
- Test: `tweaklet/web/src/contextCapture.test.ts`

- [ ] **Step 1: Write the failing tests**

`tweaklet/web/src/contextCapture.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { serializeElement, formatContext } from "./contextCapture.js";

function dom(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("serializeElement", () => {
  it("captures tag, id, classes, curated attrs, selector path, text, opening tag", () => {
    dom(`<main><section class="checkout"><form id="pay"><button id="go" class="cta primary" type="submit" data-testid="place-order" aria-label="Place order" style="color:red">Place order</button></form></section></main>`);
    const btn = document.querySelector("button")!;
    const s = serializeElement(btn);
    expect(s.tag).toBe("button");
    expect(s.id).toBe("go");
    expect(s.classes).toEqual(["cta", "primary"]);
    expect(s.attrs).toEqual({ type: "submit", "data-testid": "place-order", "aria-label": "Place order" }); // no class/id/style
    expect(s.selectorPath).toBe("main > section.checkout > form#pay > button#go.cta.primary");
    expect(s.text).toBe("Place order");
    expect(s.html).toMatch(/^<button[^>]*>$/);
  });

  it("handles no id / no classes / no capturable attrs", () => {
    const div = dom(`<div><span>hi</span></div>`).querySelector("span")!;
    const s = serializeElement(div);
    expect(s.id).toBe("");
    expect(s.classes).toEqual([]);
    expect(s.attrs).toEqual({});
    expect(s.selectorPath).toBe("div > span");
  });

  it("trims long text to 120 chars", () => {
    const p = dom(`<p>${"x".repeat(200)}</p>`);
    expect(serializeElement(p).text).toHaveLength(120);
  });
});

describe("formatContext", () => {
  it("formats page + element", () => {
    const out = formatContext(
      { route: "/checkout", title: "Checkout" },
      { tag: "button", id: "go", classes: ["cta"], attrs: { type: "submit", "data-testid": "place-order" }, selectorPath: "form#pay > button#go.cta", text: "Place order", html: "<button>" },
    );
    expect(out).toContain("[Page] route: /checkout · title: \"Checkout\"");
    expect(out).toContain("[Selected element] button#go.cta");
    expect(out).toContain("selector: form#pay > button#go.cta");
    expect(out).toContain("text: \"Place order\"");
    expect(out).toContain("attrs: type=submit, data-testid=place-order");
  });

  it("page only when no element; empty string when neither", () => {
    expect(formatContext({ route: "/x", title: "X" }, null)).toContain("[Page] route: /x");
    expect(formatContext({ route: "/x", title: "X" }, null)).not.toContain("[Selected element]");
    expect(formatContext(null, null)).toBe("");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm --prefix web test -- contextCapture.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `contextCapture.ts`**

```ts
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
  for (let depth = 0; cur && depth < 5; depth++) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) seg += "#" + cur.id;
    else if (cur.classList.length) seg += "." + Array.from(cur.classList).join(".");
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
export function formatContext(page: PageContext | null, element: PickedElement | null): string {
  const lines: string[] = [];
  if (page) lines.push(`[Page] route: ${page.route} · title: ${JSON.stringify(page.title)}`);
  if (element) {
    const head = element.tag + (element.id ? "#" + element.id : "") + (element.classes.length ? "." + element.classes.join(".") : "");
    lines.push(`[Selected element] ${head}`);
    lines.push(`  selector: ${element.selectorPath}`);
    if (element.text) lines.push(`  text: ${JSON.stringify(element.text)}`);
    const attrs = Object.entries(element.attrs).map(([k, v]) => `${k}=${v}`).join(", ");
    if (attrs) lines.push(`  attrs: ${attrs}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npm --prefix web test -- contextCapture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tweaklet/web/src/contextCapture.ts tweaklet/web/src/contextCapture.test.ts
git commit -m "feat(tweaklet/web): serializeElement + formatContext (page-context capture core)"
```

---

## Task 2: Snippet element-picker + postMessage bridge

**Files:**
- Modify: `tweaklet/src/server/server.ts` (the `/snippet.js` IIFE string)

Manual/Playwright verification only — the snippet is a served JS string. Its serializer is a hand-mirror of `serializeElement` (Task 1, which is unit-tested); keep them aligned.

- [ ] **Step 1: Extend the IIFE**

In `server.ts`, inside the `/snippet.js` template string, **after** `document.body.appendChild(f); document.body.appendChild(t);` and before the closing `})();`, insert:

```js
  // ── page-context capture ───────────────────────────────────────
  function pageCtx(){ return { route: location.pathname, title: document.title }; }
  // Inline mirror of web/src/contextCapture.ts serializeElement — keep aligned.
  function serialize(el){
    var attrs={};
    for(var i=0;i<el.attributes.length;i++){ var a=el.attributes[i], n=a.name;
      if(n==='class'||n==='id'||n==='style')continue;
      if(n.indexOf('data-')===0||n.indexOf('aria-')===0||['role','name','type','href','alt','placeholder','title'].indexOf(n)>=0)attrs[n]=a.value; }
    var path=[], cur=el, depth=0;
    while(cur&&cur.nodeType===1&&cur.tagName.toLowerCase()!=='body'&&depth<5){ var seg=cur.tagName.toLowerCase();
      if(cur.id)seg+='#'+cur.id; if(cur.classList&&cur.classList.length)seg+='.'+Array.prototype.join.call(cur.classList,'.');
      path.unshift(seg); cur=cur.parentElement; depth++; }
    var m=el.outerHTML.match(/^<[^>]*>/);
    return { tag:el.tagName.toLowerCase(), id:el.id||'', classes:Array.prototype.slice.call(el.classList||[]),
      attrs:attrs, selectorPath:path.join(' > '), text:(el.textContent||'').trim().slice(0,120), html:m?m[0]:'' };
  }
  var picker=null;
  function clearPicker(){ if(!picker)return; document.removeEventListener('mousemove',picker.mm,true); document.removeEventListener('click',picker.cl,true); document.removeEventListener('keydown',picker.kd,true); picker.box.remove(); picker=null; }
  function elAt(x,y){ if(picker)picker.box.style.display='none'; var e=document.elementFromPoint(x,y); if(picker)picker.box.style.display='block'; return e; }
  function startPicker(){
    if(picker)return;
    var box=document.createElement('div');
    box.style.cssText='position:fixed;z-index:2147483645;border:2px solid #0f9d6b;background:rgba(15,157,107,.12);pointer-events:none;border-radius:3px';
    document.body.appendChild(box);
    var cur=null;
    var mm=function(ev){ var e=elAt(ev.clientX,ev.clientY); if(!e||e===t||e===f)return; cur=e; var r=e.getBoundingClientRect(); box.style.left=r.left+'px'; box.style.top=r.top+'px'; box.style.width=r.width+'px'; box.style.height=r.height+'px'; };
    var cl=function(ev){ ev.preventDefault(); ev.stopPropagation(); var e=cur||elAt(ev.clientX,ev.clientY); clearPicker(); if(e){ f.contentWindow.postMessage({type:'tweaklet:element',element:serialize(e),page:pageCtx()}, base); set(true); } };
    var kd=function(ev){ if(ev.key==='Escape')clearPicker(); };
    document.addEventListener('mousemove',mm,true);
    document.addEventListener('click',cl,true);
    document.addEventListener('keydown',kd,true);
    picker={box:box,mm:mm,cl:cl,kd:kd};
  }
  window.addEventListener('message',function(ev){
    if(ev.origin!==base)return;                       // only our own panel iframe
    var d=ev.data||{};
    if(d.type==='tweaklet:pick-start'){ set(false); startPicker(); }   // collapse panel so the page is visible
    else if(d.type==='tweaklet:hello'){ f.contentWindow.postMessage({type:'tweaklet:page',page:pageCtx()}, base); }
  });
```

- [ ] **Step 2: Build the backend (the snippet is part of the server bundle)**

Run: `npm run build`
Expected: clean (`tsc` passes — the string is inert to the type checker).

- [ ] **Step 3: Commit**

```bash
git add tweaklet/src/server/server.ts
git commit -m "feat(tweaklet): snippet element-picker overlay + postMessage context bridge"
```

---

## Task 3: Panel — Pick control, message listener, chip, prompt integration

**Files:**
- Modify: `tweaklet/web/src/Panel.tsx`
- Modify: `tweaklet/web/src/panel.css`
- Test: `tweaklet/web/src/Panel.test.tsx`

- [ ] **Step 1: Write failing tests in `Panel.test.tsx`**

Add (uses real `window` message dispatch; `event.source` defaults to `window`, which equals `window.parent` in jsdom — satisfying the gate):
```ts
  it("shows a context chip when the host posts a picked element, and clears it", async () => {
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: { type: "tweaklet:element", page: { route: "/checkout", title: "Checkout" },
        element: { tag: "button", id: "go", classes: ["cta"], attrs: { type: "submit" }, selectorPath: "form#pay > button#go.cta", text: "Place order", html: "<button>" } },
    }));
    expect(await screen.findByText(/button#go\.cta/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear selected element/i }));
    expect(screen.queryByText(/button#go\.cta/)).toBeNull();
  });

  it("prepends the context block to the prompt sent to the agent", async () => {
    streamPrompt.mockResolvedValue({ type: "end", code: 0 });
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: { type: "tweaklet:element", page: { route: "/checkout", title: "Checkout" },
        element: { tag: "button", id: "go", classes: ["cta"], attrs: { type: "submit" }, selectorPath: "form#pay > button#go.cta", text: "Place order", html: "<button>" } },
    }));
    await screen.findByText(/button#go\.cta/);
    fireEvent.change(screen.getByPlaceholderText(/describe a change/i), { target: { value: "make it bigger" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));
    const sent = streamPrompt.mock.calls[0][0] as string;
    expect(sent).toContain("[Selected element] button#go.cta");
    expect(sent).toContain("make it bigger");
    expect(sent.indexOf("[Selected element]")).toBeLessThan(sent.indexOf("make it bigger")); // context first
  });

  it("ignores messages whose source is not window.parent", async () => {
    render(<Panel />);
    await screen.findByRole("button", { name: /alice/i });
    window.dispatchEvent(new MessageEvent("message", {
      source: {} as any, // not window.parent
      data: { type: "tweaklet:element", page: { route: "/x", title: "X" },
        element: { tag: "div", id: "", classes: [], attrs: {}, selectorPath: "div", text: "", html: "<div>" } },
    }));
    // nothing rendered
    expect(screen.queryByText(/selector/i)).toBeNull();
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `npm --prefix web test -- Panel.test.tsx`
Expected: FAIL (no chip / context not prepended / no listener).

- [ ] **Step 3: Implement in `Panel.tsx`**

(a) Import the formatter + types at the top (after the existing `./api.js` import):
```ts
import { formatContext, type PickedElement, type PageContext } from "./contextCapture.js";
```
(b) Add state near the other `useState`s:
```ts
  const [page, setPage] = useState<PageContext | null>(null);
  const [picked, setPicked] = useState<PickedElement | null>(null);
```
(c) Add the message listener + a host "hello" on mount, after the existing effects:
```ts
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== window.parent) return;            // only the embedding host
      const d = e.data as { type?: string; page?: PageContext; element?: PickedElement };
      if (typeof d?.type !== "string" || !d.type.startsWith("tweaklet:")) return;
      if (d.page) setPage(d.page);
      if (d.type === "tweaklet:element" && d.element) setPicked(d.element);
    }
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "tweaklet:hello" }, "*"); // ask the host for page context
    return () => window.removeEventListener("message", onMsg);
  }, []);
```
(d) The Pick control posts to the host:
```ts
  const startPick = () => window.parent.postMessage({ type: "tweaklet:pick-start" }, "*");
```
(e) Prepend context in `send()` — change the `streamPrompt(text, …)` call to send the combined string while still displaying `text`:
```ts
      const ctx = formatContext(page, picked);
      const sent = ctx ? `${ctx}\n\n${text}` : text;
      await streamPrompt(sent, (e: any) => {
```
(The `push({ kind: "you", text })` above is unchanged — the user still sees just their text.)

(f) Render the Pick control + chip inside `.apz-input`, before the `<textarea>`:
```tsx
        <div className="apz-input">
          {picked ? (
            <span className="apz-ctx-chip" title={picked.selectorPath}>
              📍 {picked.tag}{picked.id ? "#" + picked.id : ""}{picked.classes.length ? "." + picked.classes.join(".") : ""}
              <button type="button" className="apz-ctx-clear" aria-label="Clear selected element" onClick={() => setPicked(null)}>✕</button>
            </span>
          ) : (
            <button type="button" className="apz-ctx-pick" aria-label="Pick an element on the page" title="Pick an element on the page" onClick={startPick}>📍</button>
          )}
          <textarea
            ref={taRef}
            …unchanged…
```

- [ ] **Step 4: Styles in `panel.css`**

```css
.apz-ctx-pick {
  flex: none; width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); font-size: 14px;
  display: grid; place-items: center; transition: border-color .15s, background .15s;
}
.apz-ctx-pick:hover { border-color: var(--accent); background: var(--accent-tint); }
.apz-ctx-chip {
  flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 50%;
  font-size: 11px; color: var(--accent-d); background: var(--accent-tint);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 8px; padding: 4px 6px 4px 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.apz-ctx-clear { border: 0; background: none; color: var(--accent-d); cursor: pointer; font-size: 11px; padding: 0 2px; }
.apz-ctx-clear:hover { color: var(--err); }
```

- [ ] **Step 5: Run web tests + build + commit**

Run: `npm --prefix web test` then `npm --prefix web run build`
Expected: all web tests PASS + clean build.

```bash
git add tweaklet/web/src/Panel.tsx tweaklet/web/src/panel.css tweaklet/web/src/Panel.test.tsx
git commit -m "feat(tweaklet/web): Pick-element control + context chip + prompt context block"
```

---

## Task 4: Full verification + manual smoke

- [ ] **Step 1: Full local checks**

Run, from `tweaklet/`:
```bash
npm run build && npm test
npm --prefix web run build && npm --prefix web test
```
Expected: both builds clean; all backend + web tests PASS.

- [ ] **Step 2: Restart the server + smoke-test the picker**

```bash
pkill -f "dist/index.js serve" || true
( cd /Users/joseph/Projects/transcenda/t8a && PATH=/opt/homebrew/Cellar/node/25.9.0_2/bin:$PATH node tweaklet/dist/index.js serve & )
```
Then, with the t8a frontend on `:5173` and the widget embedded: open the panel, click 📍, confirm hovering the host page highlights elements, click one, confirm the chip appears (e.g. `📍 button.cta-primary`), send a prompt, and confirm (via the agent stream / server logs) the prompt began with the `[Page]` / `[Selected element]` block. Esc cancels the picker. No console errors in either frame.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "test(tweaklet): verify page-context capture end-to-end"
```

---

## Self-Review notes (for the implementer)
- **Serializer mirror:** `server.ts`'s inline `serialize()` mirrors the unit-tested `serializeElement` in `contextCapture.ts`. If you change one, change both; the jsdom test is the source of truth for the shape.
- **jsdom message gate:** in tests, `MessageEvent.source` defaults to `null`; we pass `source: window`, and jsdom's `window.parent === window`, so the `e.source !== window.parent` gate passes for the "host" tests and fails for the bogus-source test — matching production where only the real parent host frame is honored.
- **Standalone panel:** when not embedded (`/panel` opened directly), `window.parent === window`; the `hello`/`pick-start` posts go to self with no snippet listening, so `page` stays null and Pick is a no-op — graceful, per spec.
- **Context rides in the prompt string:** no `/api/agent/prompt` or `streamPrompt` signature change; the agent gets the block as the first lines of its prompt.
