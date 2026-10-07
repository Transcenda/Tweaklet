import { describe, it, expect, beforeEach } from "vitest";
import { inspectDom } from "./dom-inspect.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("inspectDom", () => {
  it("returns exists=true with text and outerHTML for a present element", () => {
    document.body.innerHTML = '<h1 id="t">Hello</h1>';
    const r = inspectDom("#t");
    expect(r.exists).toBe(true);
    expect(r.text).toBe("Hello");
    expect(r.outerHTML).toContain("Hello");
  });

  it("returns exists=false for an absent selector", () => {
    expect(inspectDom("#nope").exists).toBe(false);
  });

  it("returns exists=false for an invalid selector and does not throw", () => {
    expect(inspectDom("::::").exists).toBe(false);
  });

  it("caps outerHTML at 4000 characters", () => {
    const huge = "x".repeat(5000);
    document.body.innerHTML = `<div id="big">${huge}</div>`;
    const r = inspectDom("#big");
    expect(r.exists).toBe(true);
    expect((r.outerHTML ?? "").length).toBeLessThanOrEqual(4000);
  });

  it("caps text at 2000 characters", () => {
    const huge = "y".repeat(3000);
    document.body.innerHTML = `<p id="p">${huge}</p>`;
    const r = inspectDom("#p");
    expect(r.exists).toBe(true);
    expect((r.text ?? "").length).toBeLessThanOrEqual(2000);
  });

  it("returns a computedStyle object with the expected keys", () => {
    document.body.innerHTML = '<span id="s">hi</span>';
    const r = inspectDom("#s");
    expect(r.exists).toBe(true);
    expect(r.computedStyle).toBeDefined();
    expect(r.computedStyle).toHaveProperty("display");
  });
});

// ── Security: the result goes to an LLM, so it must never carry page secrets ──

// Obviously fake token-shaped values (never real credentials).
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlZmFrZQ";
const FAKE_OPAQUE = "abc123def456ghi789jkl012mno345pqr678";

describe("inspectDom refusals", () => {
  it.each([
    ["head"],
    ["head meta"],
    ["meta[name=csrf-token]"],
    ["link[rel=stylesheet]"],
    ["script"],
    ["body script"],
    ["style"],
    ["template"],
    ["noscript"],
    ["iframe"],
    ["html"],
    [":root"],
  ])("refuses %s with a reason and no content", (sel) => {
    document.head.innerHTML = '<meta name="csrf-token" content="secret-value"><link rel="stylesheet" href="/a.css">';
    document.body.innerHTML = '<script>var k="secret-value"</script><style>.a{}</style><template><p>t</p></template><iframe src="about:blank"></iframe><noscript>n</noscript>';
    const r = inspectDom(sel);
    expect(r.exists).toBe(false);
    expect(typeof r.refused).toBe("string");
    expect(r.refused!.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("refuses an element nested inside a refused tag (e.g. svg <style>)", () => {
    document.body.innerHTML = '<svg><style id="inner">.x{}</style></svg>';
    const r = inspectDom("#inner");
    expect(r.exists).toBe(false);
    expect(r.refused).toBeTruthy();
  });

  it("does not refuse classes or ids that merely contain a blocked word", () => {
    document.body.innerHTML = '<div class="head script-box" id="style">ok</div>';
    expect(inspectDom(".head").exists).toBe(true);
    expect(inspectDom(".script-box").exists).toBe(true);
    expect(inspectDom("#style").exists).toBe(true);
  });

  it("scopes queries to the body (html body … selectors still work)", () => {
    document.body.innerHTML = '<main><h1 class="t">Hi</h1></main>';
    const r = inspectDom("html body main .t");
    expect(r.exists).toBe(true);
    expect(r.text).toBe("Hi");
  });
});

describe("inspectDom redaction", () => {
  it("strips script/style/template/noscript/iframe children from the returned HTML and text", () => {
    document.body.innerHTML =
      '<div id="w"><p>Visible</p><script>window.KEY="secret-value"</script><style>.s{}</style>' +
      '<template><b>tpl-secret</b></template><noscript>ns-secret</noscript><iframe src="/x"></iframe><!-- comment-secret --></div>';
    const r = inspectDom("#w");
    expect(r.exists).toBe(true);
    expect(r.outerHTML).toContain("Visible");
    for (const s of ["<script", "secret-value", "<style", "<template", "tpl-secret", "<noscript", "ns-secret", "<iframe", "comment-secret"]) {
      expect(r.outerHTML).not.toContain(s);
    }
    expect(r.text).toBe("Visible");
  });

  it("drops form values, typed values, hidden and password inputs", () => {
    document.body.innerHTML =
      '<form id="f"><input name="email" value="alice@example.com"><input type="hidden" name="csrf" value="hidden-secret">' +
      '<input type="password" name="pw" value="pw-secret"><textarea name="note">draft-secret</textarea>' +
      '<select name="s" value="sel-secret"><option>One</option></select><button>Save</button></form>';
    const typed = document.querySelector('input[name="email"]') as HTMLInputElement;
    typed.value = "typed-secret";
    const r = inspectDom("#f");
    expect(r.exists).toBe(true);
    const all = JSON.stringify(r);
    for (const s of ["alice@example.com", "hidden-secret", "pw-secret", "draft-secret", "sel-secret", "typed-secret", 'type="password"', 'type="hidden"']) {
      expect(all).not.toContain(s);
    }
    // Structure the agent needs is kept.
    expect(r.outerHTML).toContain('name="email"');
    expect(r.outerHTML).toContain("<textarea");
    expect(r.outerHTML).toContain("Save");
  });

  it("removes secret-named attributes and opaque data-* values but keeps ids, classes, roles and aria-*", () => {
    document.body.innerHTML =
      `<div id="card" class="card big" role="region" aria-label="Profile" data-testid="profile" ` +
      `data-session="${FAKE_OPAQUE}" data-auth-token="tok" csrf="c" x-api-key="k" nonce="n">Body</div>`;
    const r = inspectDom("#card");
    const html = r.outerHTML ?? "";
    expect(html).toContain('id="card"');
    expect(html).toContain('class="card big"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Profile"');
    expect(html).toContain('data-testid="profile"');
    for (const s of ["data-session", FAKE_OPAQUE, "data-auth-token", "csrf=", "x-api-key", "nonce="]) {
      expect(html).not.toContain(s);
    }
  });

  it("replaces JWTs and long opaque tokens in text and attribute values with [redacted]", () => {
    document.body.innerHTML =
      `<p id="t">Your token is ${FAKE_JWT} and key ${FAKE_OPAQUE} ok</p>` +
      `<a id="l" href="/cb?code=${FAKE_OPAQUE}">link</a>`;
    const r = inspectDom("#t");
    expect(r.text).toContain("[redacted]");
    expect(r.text).toContain("Your token is");
    expect(JSON.stringify(r)).not.toContain(FAKE_JWT);
    expect(JSON.stringify(r)).not.toContain(FAKE_OPAQUE);
    const l = inspectDom("#l");
    expect(JSON.stringify(l)).not.toContain(FAKE_OPAQUE);
    expect(l.text).toBe("link");
  });

  it("does not mutate the live page", () => {
    document.body.innerHTML = '<div id="w"><script>1</script><input value="v" type="hidden"></div>';
    inspectDom("#w");
    expect(document.querySelector("#w script")).not.toBeNull();
    expect(document.querySelector("#w input")).not.toBeNull();
  });
});
