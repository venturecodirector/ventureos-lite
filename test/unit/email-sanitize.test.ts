import { describe, it, expect } from "vitest";
import {
  sanitizeEmailHtml,
  htmlToText,
  BLOCKED_IMAGE_ATTR,
} from "@/modules/email/sanitize";

/**
 * Email HTML is the most hostile input this product accepts: written by
 * anyone, rendered in an authenticated session. These pin the two properties
 * that matter — nothing executes, and nothing phones home unasked.
 */
describe("script execution", () => {
  it("removes script tags and their contents", () => {
    const { html } = sanitizeEmailHtml('<p>hi</p><script>alert(document.cookie)</script>');
    expect(html).toContain("hi");
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert");
  });

  it("removes event handlers", () => {
    const { html } = sanitizeEmailHtml('<p onclick="steal()" onmouseover="x()">hi</p>');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onmouseover");
    expect(html).toContain("hi");
  });

  it("refuses javascript: and data: links", () => {
    const js = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(js.html).not.toContain("javascript:");
    const data = sanitizeEmailHtml('<a href="data:text/html,<script>x</script>">click</a>');
    expect(data.html).not.toContain("data:text/html");
  });

  it("keeps ordinary links, but opens them safely", () => {
    const { html } = sanitizeEmailHtml('<a href="https://pelda.hu/arak">árak</a>');
    expect(html).toContain('href="https://pelda.hu/arak"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it("drops style attributes entirely", () => {
    // position/opacity/z-index are enough to overlay invisible content on top
    // of the app's own interface.
    const { html } = sanitizeEmailHtml(
      '<div style="position:fixed;top:0;left:0;opacity:0.01;z-index:9999">x</div>',
    );
    expect(html).not.toContain("position");
    expect(html).not.toContain("style=");
  });

  it("strips iframes, objects and forms", () => {
    const { html } = sanitizeEmailHtml(
      '<iframe src="https://evil.hu"></iframe><object data="x"></object><form action="/x"><input></form>',
    );
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("object");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  it("keeps the formatting a real email actually uses", () => {
    const { html } = sanitizeEmailHtml(
      "<p><b>Kedves Tamás,</b></p><ul><li>egy</li><li>kettő</li></ul><table><tr><td>ár</td></tr></table>",
    );
    expect(html).toContain("<b>");
    expect(html).toContain("<li>");
    expect(html).toContain("<td>");
  });
});

describe("remote images are read receipts", () => {
  it("parks a remote image instead of loading it", () => {
    const { html, blockedImages } = sanitizeEmailHtml(
      '<img src="https://tracker.example/open.gif?id=abc" width="1" height="1">',
    );
    expect(blockedImages).toBe(1);
    expect(html).toContain(BLOCKED_IMAGE_ATTR);
    // The src must be gone, or the browser fetches it the moment it parses.
    expect(html).not.toMatch(/\ssrc="https:\/\/tracker/);
  });

  it("keeps the URL so the operator can choose to load it", () => {
    const { html } = sanitizeEmailHtml('<img src="https://cdn.pelda.hu/logo.png">');
    expect(html).toContain("https://cdn.pelda.hu/logo.png");
  });

  it("allows inline images that came with the message", () => {
    // cid: and data: disclose nothing by rendering — they are already here.
    const cid = sanitizeEmailHtml('<img src="cid:logo123">');
    expect(cid.html).toContain('src="cid:logo123"');
    expect(cid.blockedImages).toBe(0);

    const data = sanitizeEmailHtml('<img src="data:image/png;base64,AAAA">');
    expect(data.html).toContain("data:image/png;base64,AAAA");
    expect(data.blockedImages).toBe(0);
  });

  it("counts several trackers", () => {
    const { blockedImages } = sanitizeEmailHtml(
      '<img src="https://a.hu/1.gif"><img src="https://b.hu/2.gif">',
    );
    expect(blockedImages).toBe(2);
  });
});

describe("htmlToText", () => {
  it("gives the AI and the snippet plain words, never markup", () => {
    expect(htmlToText("<p>Kedves <b>Tamás</b>,</p><p>köszönöm!</p>")).toBe(
      "Kedves Tamás, köszönöm!",
    );
  });

  it("drops script contents rather than reading them aloud", () => {
    expect(htmlToText("<script>secret()</script><p>hello</p>")).toBe("hello");
  });

  it("handles empty input", () => {
    expect(htmlToText(null)).toBe("");
    expect(sanitizeEmailHtml(undefined).html).toBe("");
  });
});
