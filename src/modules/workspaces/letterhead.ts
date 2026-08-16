/**
 * The shared letterhead (audit-v2 item 6).
 *
 * Every branded artefact — quote, contract, certificate, audit report, meeting
 * brief, Friday report, commission run — used to carry its own copy of the
 * wordmark markup and its own hardcoded colours. That is fine for one company
 * and wrong for a product: the second workspace hands a client a document
 * signed by someone else's agency.
 *
 * All of it comes from here now, driven by CSS custom properties rather than by
 * naming tokens, which is what lets one template serve every workspace and what
 * makes "no hardcoded brand string" something a grep test can check.
 */

import {
  brandCssVarsInline,
  brandFooterLine,
  type WorkspaceBrand,
} from "./brand";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The `style` attribute for a document root, carrying every brand variable.
 *
 * On the root rather than in a `:root {}` rule so a template can be embedded in
 * a page that already has its own variables without them colliding.
 *
 * ESCAPED, and that is not incidental. A font stack contains `"Segoe UI"`, and
 * a double quote inside a double-quoted HTML attribute terminates it — which
 * silently threw away every variable after it and left the PDFs rendering in
 * the browser's default serif. A pixel comparison against the pre-change build
 * is what surfaced it; nothing about the markup looked wrong.
 */
export function brandRootStyle(brand: WorkspaceBrand): string {
  return brandCssVarsInline(brand).replace(/"/g, "&quot;");
}

/**
 * The wordmark, or the logo when one is uploaded.
 *
 * A logo REPLACES the wordmark rather than sitting beside it: two identities on
 * one letterhead reads as a co-branding nobody asked for.
 */
export function brandMarkHtml(brand: WorkspaceBrand, opts: { size?: number } = {}): string {
  const size = opts.size ?? 22;
  if (brand.logoUrl) {
    return `<div class="brand"><img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" style="height:${Math.round(size * 1.5)}px;max-width:280px;object-fit:contain"></div>`;
  }
  const light = brand.markLight
    ? `<span>${esc(brand.markLight)}</span>`
    : "";
  return `<div class="brand"><b>${esc(brand.markBold)}</b>${light}</div>`;
}

/** The footer identity line, already assembled from whatever is configured. */
export function brandFooterHtml(brand: WorkspaceBrand): string {
  return esc(brandFooterLine(brand));
}

/**
 * The CSS every branded PDF shares.
 *
 * Emitted as one block so the mark, the footer and the accent behave the same
 * everywhere — the previous arrangement had six near-identical copies that had
 * already drifted apart in the margins.
 */
export function brandBaseCss(): string {
  return `
  .brand { font-size: 22px; letter-spacing: -0.02em; }
  .brand b { font-weight: 800; }
  .brand span { font-weight: 300; color: var(--brand-muted); margin-left: 6px; }
  .brand img { display: block; }
  .brand-footer { color: var(--brand-muted); font-size: 9px; }
  `;
}
