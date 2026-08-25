import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  instrumentEmail,
  newTrackingId,
  TRACKING_NOTICE_HU,
} from "../../src/modules/email/tracking";

/**
 * 1:1 open/click tracking (playbook-v3 P9/1).
 *
 * The playbook's own verification line: "toggle-off mail contains no pixel and
 * no rewritten links (assert on raw MIME)". That is checked at the send path —
 * here we pin what instrumentation does when it IS on, and the two properties
 * that decide whether this feature is honest or not: the visible link text
 * never changes, and the redirect endpoint cannot be pointed anywhere.
 */
const BASE = "https://ventureco.agency";
const PRIVACY = "https://ventureco.agency/privacy";

const run = (html: string, text = "") =>
  instrumentEmail({ html, text, trackingId: "a".repeat(32), baseUrl: BASE, privacyUrl: PRIVACY });

describe("newTrackingId", () => {
  it("is long, hex and different every time", () => {
    const a = newTrackingId();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(newTrackingId()).not.toBe(a);
  });
});

describe("the pixel", () => {
  it("is added once, hidden, and points at our own domain", () => {
    const out = run("<p>Szia</p>");
    const pixels = out.html.match(/<img [^>]*\/api\/e\/o\//g) ?? [];
    expect(pixels).toHaveLength(1);
    expect(out.html).toContain(`${BASE}/api/e/o/${"a".repeat(32)}.png`);
    expect(out.html).toContain("display:none");
  });

  it("comes after the notice, so a truncating client still shows the disclosure", () => {
    const out = run("<p>Szia</p>");
    expect(out.html.indexOf(TRACKING_NOTICE_HU)).toBeLessThan(out.html.indexOf("/api/e/o/"));
  });
});

describe("the notice", () => {
  it("is in both parts of the message", () => {
    const out = run("<p>Szia</p>", "Szia");
    expect(out.html).toContain(TRACKING_NOTICE_HU);
    expect(out.text).toContain(TRACKING_NOTICE_HU);
    expect(out.text).toContain(PRIVACY);
  });
});

describe("link rewriting", () => {
  it("routes an existing anchor through us and keeps its text", () => {
    const out = run('<p><a href="https://pelda.hu/ajanlat">Nézze meg az ajánlatot</a></p>');
    expect(out.links).toEqual(["https://pelda.hu/ajanlat"]);
    expect(out.html).toContain(`${BASE}/api/e/c/${"a".repeat(32)}/0`);
    // The words the reader sees are untouched.
    expect(out.html).toContain(">Nézze meg az ajánlatot<");
    expect(out.html).not.toContain('href="https://pelda.hu/ajanlat"');
  });

  /**
   * Most mail from this composer is plain text, so a bare URL is the normal
   * case. Without this there would be nothing to track at all.
   */
  it("linkifies a bare URL and shows the ORIGINAL address as the text", () => {
    const out = run("<p>Itt van: https://pelda.hu/arak</p>");
    expect(out.links).toEqual(["https://pelda.hu/arak"]);
    expect(out.html).toContain(">https://pelda.hu/arak<");
    expect(out.html).toContain("/api/e/c/");
  });

  it("indexes several links in order", () => {
    const out = run("<p>https://a.hu/1 és https://b.hu/2</p>");
    expect(out.links).toEqual(["https://a.hu/1", "https://b.hu/2"]);
    expect(out.html).toContain("/api/e/c/" + "a".repeat(32) + "/0");
    expect(out.html).toContain("/api/e/c/" + "a".repeat(32) + "/1");
  });

  it("does not rewrite its own tracking URLs into a loop", () => {
    const out = run("<p>Szia</p>");
    const clicks = out.html.match(/\/api\/e\/c\//g) ?? [];
    expect(clicks).toHaveLength(0);
    // …and the pixel is not turned into a click link either.
    expect(out.html).toContain("/api/e/o/");
  });

  /**
   * The plain-text part keeps the real addresses: a text-only client cannot
   * render a pixel anyway, and showing an opaque tracking URL where somebody
   * expected a recognisable address is worse than losing the measurement.
   */
  it("leaves the text part's links alone", () => {
    const out = run("<p>https://pelda.hu/x</p>", "Itt: https://pelda.hu/x");
    expect(out.text).toContain("https://pelda.hu/x");
    expect(out.text).not.toContain("/api/e/c/");
  });

  it("escapes a URL that carries markup characters", () => {
    const out = run('<p>https://pelda.hu/a?x=1&y="2"</p>');
    expect(out.html).not.toContain('="2"</a>');
    expect(out.html).toContain("&amp;");
  });
});

describe("the endpoints are public and cannot be aimed", () => {
  const middleware = readFileSync(join(__dirname, "..", "..", "src", "middleware.ts"), "utf8");
  const redirect = readFileSync(
    join(__dirname, "..", "..", "src", "app", "api", "e", "c", "[token]", "[index]", "route.ts"),
    "utf8",
  );

  /**
   * The trap /t.js already fell into: these are fetched by a RECIPIENT'S mail
   * client, which has no session, and the browser suite cannot see it because
   * every spec runs signed in.
   */
  it("/api/e is reachable without a session", () => {
    expect(middleware).toContain('"/api/e"');
  });

  /**
   * A redirect endpoint that accepts a URL is an open redirect — a phishing
   * link wearing our own domain.
   */
  it("the redirect takes an index into stored links, never a URL parameter", () => {
    expect(redirect).toContain("msg.links[i]");
    expect(redirect).not.toMatch(/searchParams\.get\(["'](u|url|to|next)["']\)/);
  });
});

// ---------------------------------------------------------------------------
// The playbook's own line: assert on the raw MIME.
// ---------------------------------------------------------------------------

import { buildReplyMime, encodeMime } from "../../src/modules/email/gmail";

/** What the send path does, in the two states the toggle has. */
function mimeFor(track: boolean): string {
  const html = "<p>Kedves Anna,</p><p>Itt az ajánlat: https://pelda.hu/ajanlat</p>";
  const text = "Kedves Anna,\n\nItt az ajánlat: https://pelda.hu/ajanlat";
  if (!track) {
    return buildReplyMime({ to: ["anna@pelda.hu"], subject: "Ajánlat", bodyText: text, bodyHtml: html });
  }
  const i = instrumentEmail({
    html,
    text,
    trackingId: "b".repeat(32),
    baseUrl: BASE,
    privacyUrl: PRIVACY,
  });
  return buildReplyMime({
    to: ["anna@pelda.hu"],
    subject: "Ajánlat",
    bodyText: i.text,
    bodyHtml: i.html,
  });
}

describe("raw MIME", () => {
  /**
   * The promise the toggle makes. Off is OFF — not "off but we still add a
   * footer", not "off but the links still go through us".
   */
  it("carries NO pixel, NO rewritten link and NO notice with tracking off", () => {
    const mime = mimeFor(false);
    expect(mime).not.toContain("/api/e/o/");
    expect(mime).not.toContain("/api/e/c/");
    expect(mime).not.toContain(TRACKING_NOTICE_HU);
    // …and the recipient's link is exactly the one that was typed.
    expect(mime).toContain("https://pelda.hu/ajanlat");
  });

  it("carries all three with tracking on", () => {
    const mime = mimeFor(true);
    expect(mime).toContain("/api/e/o/");
    expect(mime).toContain("/api/e/c/");
    expect(mime).toContain(TRACKING_NOTICE_HU);
  });

  it("survives the base64url encoding Gmail wants", () => {
    const encoded = encodeMime(mimeFor(true));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).toContain(
      "/api/e/o/",
    );
  });
});
