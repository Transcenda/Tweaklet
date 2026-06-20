# Tweaklet Page-Context Capture — Design

**Date:** 2026-06-16
**Status:** Approved (design) — pending spec review before implementation
**Goal:** Give the Tweaklet agent the context of the page the user is looking at. The user picks an element on the running app (devtools-style click-to-inspect); Tweaklet captures that element plus its HTML hierarchy (tags, ids, CSS classes, attributes) and the current route, and attaches it to the agent prompt — so the agent can locate the right spot in the source by class / selector / attribute.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Targeting | **Element picker** (hover-highlight + click to select); no text-selection path in v1 |
| Automatic context | **Page route + title** included on every request, with or without a picked element |
| Attachment | **One element at a time**, shown as a **removable chip**, **sticky** until removed or replaced |
| Payload | DOM **metadata only** (tag/id/classes/attrs/selector-path/short text/opening-tag HTML) — no page data or secrets |
| Bridge | `postMessage` both ways between the host snippet and the panel iframe, origin/type-validated |
| Screenshot | **Out of scope** for v1 |

## Architecture

`snippet.js` runs in the **host page** (can read the host DOM); the panel is a **separate-origin iframe** (`TWEAKLET_ORIGIN`, e.g. `http://localhost:4319`) embedded in the host. Capture happens in the snippet; results cross to the panel via `postMessage`; the panel attaches them to the prompt sent through the existing `streamPrompt → POST /api/agent/prompt → opencode parts[].text` path.

```
Panel  ──postMessage{type:"tweaklet:pick-start"}──▶  snippet (host)
                                                       hover → highlight overlay
                                                       click → serialize element
Panel  ◀─postMessage{type:"tweaklet:element", el}───  snippet
   chip rendered above composer; on send, context is prepended to the prompt
```

## Components

### 1. Snippet (host context) — `tweaklet/src/server/server.ts` `/snippet.js`
- **Picker mode:** on `tweaklet:pick-start`, attach `mousemove` (draw/move a highlight `<div>` overlay over the element under the cursor), `click` (capture: `serializeElement(target)`, then exit), and `keydown` Esc (cancel). The overlay is a fixed-position, pointer-events:none box; capture uses `document.elementFromPoint` excluding the overlay + launcher.
- **`serializeElement(el)`** (pure, testable) → returns:
  ```ts
  {
    tag, id, classes: string[],
    attrs: Record<string,string>,        // curated: data-*, aria-*, role, name, type, href, alt, placeholder, title
    selectorPath: string,                // "main > section.checkout > form#pay > button.cta-primary" (≤5 levels)
    text: string,                        // element.innerText, trimmed to 120 chars
    html: string,                        // the element's opening tag, e.g. '<button class="cta-primary" type="submit">'
  }
  ```
- **Page context:** on the panel's request (or with each captured element), also send `{ route: location.pathname, title: document.title }`.
- Sends results: `iframe.contentWindow.postMessage({ type: "tweaklet:element", element, page }, TWEAKLET_ORIGIN)`.

### 2. Panel (iframe) — `tweaklet/web/src/Panel.tsx`
- Listens for `message` events; **accepts only `event.source === window.parent` and `type` starting `tweaklet:`**.
- A **"📍 Pick element"** control in the composer area → `window.parent.postMessage({ type: "tweaklet:pick-start" }, "*")` (target `*` is acceptable for a "start picking" signal that carries no data; the host snippet checks the type).
- State `pickedContext: { element, page } | null`. On `tweaklet:element`, set it. Render a **chip**: `📍 button.cta-primary · /checkout  ✕` (✕ clears it). Picking again replaces it.
- A small `formatContext(pickedContext, page)` builds the block prepended to the prompt on send.

### 3. Prompt integration — `tweaklet/web/src/api.ts` + `Panel.tsx`
- `send()` composes: `formatContext(...) + "\n\n" + userText` and passes the combined string to `streamPrompt`. Page context (route+title) is included whenever known; the element block is added when one is picked. Example prepended block:
  ```
  [Page] route: /checkout · title: "Checkout"
  [Selected element] button.cta-primary
    selector: main > section.checkout > form#pay > button.cta-primary
    text: "Place order"
    attrs: type=submit, data-testid=place-order
  ```
- No backend change is required — context rides inside the existing `prompt` string. (The agent already greps the repo; the selector/classes/attrs give it the search terms.)

## Security / error handling
- **Origin/type gate:** the panel ignores any `message` not from `window.parent` and not typed `tweaklet:*`.
- **Metadata only:** the serializer emits tag/id/classes/curated-attrs/selector/short-text/opening-tag only — never form values, full innerHTML, or page data. A `value`/`data-*` that looks secret is still low-risk (host is the user's own app), but we cap text at 120 chars and never serialize `<input>.value`.
- **Graceful absence:** if no host snippet responds (e.g., panel opened standalone, not embedded), the Pick button is a no-op after a short timeout and page context is simply empty — the agent still works.
- **Picker safety:** the overlay is `pointer-events:none` and excluded from `elementFromPoint`; Esc and re-clicking the launcher always exit picker mode.

## Testing
- **`serializeElement` unit tests** (jsdom): build a DOM (nested `main > section.x > button#b.cta[data-testid=go]`), serialize the button, assert `tag/id/classes/attrs/selectorPath/text/html`. Edge cases: no id, many classes, no capturable attrs.
- **`formatContext` unit test:** given a picked element + page, asserts the prepended block text; given only page, asserts page-only block.
- **Panel tests:** a `tweaklet:element` message from a stubbed `window.parent` renders the chip; ✕ clears it; sending calls `streamPrompt` with the context block prepended; a message from a non-parent source is ignored.
- Picker overlay (hover highlight, click capture, Esc) verified manually via Playwright against the live `:5173` host.

## Out of scope (YAGNI)
- Text-selection capture (picker only for v1).
- Multiple attached elements / a context list.
- Screenshots or visual snapshots.
- Backend persistence of context (it rides in the prompt string per request).
