import { randomBytes } from "node:crypto";

/**
 * Open/click instrumentation for mail we send ourselves (playbook-v3 P9/1).
 *
 * ── WHAT AN OPEN IS WORTH ──────────────────────────────────────────────────
 *
 * Not much on its own, and the UI has to say so. Apple Mail Privacy Protection
 * pre-fetches every image the moment a message arrives, so an "open" can mean
 * nobody looked; plenty of clients block images entirely, so no open can mean
 * somebody read it twice. It is a signal — "megnyitás jelzés" — and it is
 * labelled that way everywhere it appears.
 *
 * A CLICK is different. Somebody chose to follow a link, and that is evidence.
 *
 * ── AND WHAT IT MUST NOT BECOME ────────────────────────────────────────────
 *
 * A redirect endpoint that takes a URL is an open redirect: a phishing link
 * wearing our own domain. So the links are stored at send time and the endpoint
 * takes an INDEX into that list. There is no parameter an attacker can supply.
 *
 * Everything here is pure. Whether the sender wanted tracking at all is decided
 * before this is called; with it off, none of these functions run and the mail
 * goes out with no pixel, no rewritten link and no notice.
 */

export function newTrackingId(): string {
  return randomBytes(16).toString("hex");
}

/** The disclosure that every tracked message carries. */
export const TRACKING_NOTICE_HU =
  "Ez a levél megnyitás-visszajelzést tartalmaz.";

export interface Instrumented {
  html: string;
  text: string;
  /** The links found, in the order the endpoint indexes them. */
  links: string[];
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')]+/gi;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Rewrite the links, add the pixel, add the notice.
 *
 * The VISIBLE text of a link is always left as it was — the playbook is
 * explicit, and it is also the difference between a tracked link and a
 * disguised one. A reader who hovers sees our domain in the status bar, which
 * is honest; what they must never see is one address and be sent to another.
 */
export function instrumentEmail(input: {
  html: string;
  text: string;
  trackingId: string;
  /** Absolute base, e.g. https://ventureco.agency */
  baseUrl: string;
  privacyUrl: string;
}): Instrumented {
  const links: string[] = [];
  const base = input.baseUrl.replace(/\/+$/, "");

  const clickUrl = (index: number) => `${base}/api/e/c/${input.trackingId}/${index}`;

  // Existing anchors first, so a link that is already marked up keeps its text.
  let html = input.html.replace(
    /(<a\b[^>]*\bhref\s*=\s*")(https?:\/\/[^"]+)(")/gi,
    (_m, before: string, url: string, after: string) => {
      const index = links.push(url) - 1;
      return `${before}${escapeAttr(clickUrl(index))}${after}`;
    },
  );

  /**
   * Bare URLs typed into the composer become anchors whose VISIBLE text is the
   * original address. Without this, a plain-text composer would produce nothing
   * to track at all — which is most of what people actually send.
   */
  html = html.replace(URL_IN_TEXT, (url) => {
    // Anything already inside an href was handled above and now points at us.
    if (url.startsWith(`${base}/api/e/`)) return url;
    const index = links.push(url) - 1;
    return `<a href="${escapeAttr(clickUrl(index))}">${escapeAttr(url)}</a>`;
  });

  const notice = `${TRACKING_NOTICE_HU} Részletek: ${input.privacyUrl}`;
  html += `<p style="margin:18px 0 0;font-size:11px;color:#858CAE">${TRACKING_NOTICE_HU} <a href="${escapeAttr(input.privacyUrl)}" style="color:#858CAE">Részletek</a></p>`;

  // The pixel goes last, so a client that truncates a long message still shows
  // the notice above it.
  html += `<img src="${escapeAttr(`${base}/api/e/o/${input.trackingId}.png`)}" width="1" height="1" alt="" style="display:none">`;

  /**
   * The plain-text part keeps the ORIGINAL links.
   *
   * A text-only client cannot render the pixel anyway, and rewriting there
   * would show a reader an opaque tracking URL where they expected an address
   * they recognise. Clicks from those clients go unmeasured, which is the
   * honest trade.
   */
  const text = `${input.text}\n\n--\n${notice}`;

  return { html, text, links };
}

/**
 * 90-day retention for open/click feedback (playbook-v3 P9/1).
 *
 * The playbook says "90-day retention then aggregate". We DELETE instead of
 * aggregating, deliberately: the aggregate for a single 1:1 email is "opened
 * 3×", a number nobody reads three months later — and keeping it would mean
 * keeping a record of one identifiable person's reading behaviour past the
 * retention we promised them in the footer of that very message. Aggregation
 * earns its keep across thousands of campaign sends; here it would only be a
 * way of not deleting.
 */
export const TRACK_RETENTION_DAYS = 90;
