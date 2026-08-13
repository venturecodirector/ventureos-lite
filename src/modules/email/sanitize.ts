/**
 * Making a stranger's email safe to render (playbook-v2 P2a).
 *
 * Email HTML is the most hostile input this product accepts: written by anyone,
 * rendered in an authenticated session, and historically the richest source of
 * XSS in every mail client ever shipped. Two layers, because one is not enough:
 *
 *   1. this — an allowlist on ingest, so what we STORE is already safe;
 *   2. a sandboxed iframe at render, so even a sanitizer bug is contained.
 *
 * REMOTE IMAGES ARE BLOCKED, not stripped. A remote image in an email is a read
 * receipt: fetching it tells the sender the message was opened, from roughly
 * where. That is not a disclosure the product gets to make on the operator's
 * behalf, so the src is parked in a data attribute and the UI offers to load it.
 */
import sanitizeHtml from "sanitize-html";

/** Marker the renderer looks for to offer "load images". */
export const BLOCKED_IMAGE_ATTR = "data-blocked-src";

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "div", "span", "blockquote", "pre", "code",
    "b", "strong", "i", "em", "u", "s", "sub", "sup", "small",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "a", "img",
  ],
  allowedAttributes: {
    // target and rel must be listed here even though transformTags adds them:
    // the allowlist runs AFTER the transform, so omitting them silently undid
    // the noopener protection the transform exists to apply.
    a: ["href", "title", "target", "rel"],
    img: ["alt", "title", "width", "height", BLOCKED_IMAGE_ATTR, "src"],
    "*": ["align"],
  },
  // Only what a human could click. javascript:, data: and vbscript: are all
  // script execution wearing a link's clothes.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["cid", "data"] },
  // style is dropped entirely: it carries position/opacity/z-index, which is
  // enough to overlay invisible content on top of the app's own UI.
  allowedStyles: {},
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        // A link out of an email opens elsewhere, and never gets a handle on
        // the window that opened it.
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      },
    }),
    img: (tagName, attribs) => {
      const src = attribs.src ?? "";
      // Inline (cid:) and data: images came WITH the message and disclose
      // nothing by rendering. Remote ones are trackers until proven otherwise.
      if (src.startsWith("cid:") || src.startsWith("data:")) {
        return { tagName, attribs };
      }
      const { src: _dropped, ...rest } = attribs;
      return { tagName, attribs: { ...rest, [BLOCKED_IMAGE_ATTR]: src } };
    },
  },
  // Comments can hide markup that some renderers resurrect.
  allowedIframeHostnames: [],
  disallowedTagsMode: "discard",
};

export interface SanitizedBody {
  html: string;
  /** How many remote images were parked, for the "load images" prompt. */
  blockedImages: number;
}

export function sanitizeEmailHtml(raw: string | null | undefined): SanitizedBody {
  if (!raw) return { html: "", blockedImages: 0 };
  const html = sanitizeHtml(raw, OPTIONS);
  const blockedImages = (html.match(new RegExp(BLOCKED_IMAGE_ATTR, "g")) ?? []).length;
  return { html, blockedImages };
}

/**
 * A plain-text fallback when the message had no text/plain part.
 *
 * Used for snippets, search and the AI reply analysis — none of which should
 * ever be handed markup.
 */
export function htmlToText(raw: string | null | undefined): string {
  if (!raw) return "";
  // Block boundaries become spaces BEFORE the tags go. Without this,
  // "<p>Kedves Tamás,</p><p>köszönöm!</p>" collapses to "Kedves
  // Tamás,köszönöm!" — which is what the snippet shows and what the reply
  // analysis reads.
  const spaced = raw.replace(
    /<\/(p|div|li|tr|h[1-6]|blockquote|td)>|<br\s*\/?>/gi,
    " ",
  );
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
