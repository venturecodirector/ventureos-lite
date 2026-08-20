import {
  SEED_EMAIL_BORDER,
  SEED_EMAIL_PANEL,
  VENTURE_BRAND,
  brandFooterLine,
  type WorkspaceBrand,
} from "@/modules/workspaces/brand";
/**
 * Brand layout for transactional email.
 *
 * Every sender built its own `<p>` soup, so booking confirmations, quote
 * notifications and the weekly report all arrived as unstyled browser-default
 * text with no sender identity on them.
 *
 * Written for email clients, not browsers, which is why it looks dated:
 *   - tables for layout; Outlook (Word rendering engine) ignores flex/grid
 *   - every style inline; <style> blocks are stripped by Gmail and others
 *   - no web fonts — Bricolage Grotesque cannot load in email, so the display
 *     face degrades to a system stack rather than being faked with images
 *   - the accent gradient is a background-image with a solid #7427C6 behind it,
 *     so clients that drop gradients still get brand purple
 *   - fixed 600px content width, the widest that survives Outlook's preview
 *
 * Tokens match docs/prototype.html and CLAUDE.md exactly: canvas #00051D,
 * panel rgba(239,241,248,0.04) flattened to an opaque hex (email clients are
 * unreliable with alpha over a table background), border rgba(239,241,248,0.09)
 * likewise, ink #EFF1F8, muted #858CAE, accent #7427C6.
 */

/**
 * The email palette, derived per send from the sending workspace's brand
 * (audit-v2 item 6).
 *
 * HTML email cannot use CSS custom properties — Outlook and several webmail
 * clients strip or ignore them — so the values are interpolated as literal hex
 * at render time instead. That is why this file computes a palette rather than
 * emitting `var(--brand-*)` like the PDF templates do.
 *
 * PANEL and BORDER are derived by mixing the accent-free surface toward the
 * text colour, so a light-canvas workspace gets a light panel rather than the
 * seed's near-black one.
 */
/**
 * The seed's panel and border were hand-picked flattenings of the translucent
 * tokens over the navy canvas, not the output of a formula — so they are kept
 * verbatim rather than approximated. Mixing produced #0A0E26 and #1D2137
 * against the originals' #0A0F26 and #1B2138: close, and visibly not the same
 * email. A configured workspace gets the mix, which is what it is for.
 */


function paletteOf(brand: WorkspaceBrand) {
  const seedSurfaces =
    brand.canvas === VENTURE_BRAND.canvas && brand.ink === VENTURE_BRAND.ink;
  return {
    canvas: brand.canvas,
    panel: seedSurfaces ? SEED_EMAIL_PANEL : mix(brand.canvas, brand.ink, 0.04),
    border: seedSurfaces ? SEED_EMAIL_BORDER : mix(brand.canvas, brand.ink, 0.12),
    ink: brand.ink,
    muted: brand.muted,
    accent: brand.color,
    gradient: `linear-gradient(135deg, ${brand.gradientFrom}, ${brand.gradientTo})`,
  };
}

/** Blend two hex colours. Used only to derive the panel and border surfaces. */
function mix(from: string, to: string, amount: number): string {
  const parse = (hex: string) => {
    const v = hex.replace("#", "");
    const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const a = parse(from);
  const b = parse(to);
  const out = a.map((c, i) => Math.round(c + (b[i] - c) * amount));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Flattened equivalents of the translucent panel/border tokens over canvas. */

/**
 * The historical email font chain, kept verbatim so an unconfigured workspace's
 * mail renders exactly as it did. A configured body font is prepended.
 */
const EMAIL_FONT_FALLBACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif";

function emailFont(brand: WorkspaceBrand): string {
  return brand.fontBody === VENTURE_BRAND.fontBody
    ? EMAIL_FONT_FALLBACK
    : `'${brand.fontBody}', ${EMAIL_FONT_FALLBACK}`;
}

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailRow {
  label: string;
  value: string;
}

/**
 * One headline number. Reports live or die on these being readable at a glance,
 * so they are laid out as a row of boxes rather than as a sentence.
 */
export interface EmailMetric {
  label: string;
  value: string;
  /** A smaller line under the number — a comparison, a share, a unit. */
  hint?: string;
}

/**
 * A block within a report: a heading, then any of prose, bullets or a
 * label/value table. Reports are made of several of these; a transactional
 * email is made of none.
 */
export interface EmailSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  rows?: EmailRow[];
  /** Draw the section as a panel of its own, for a conclusion or a warning. */
  emphasis?: boolean;
}

export interface BrandEmailOptions {
  /** Shown in the inbox preview line after the subject. Not rendered. */
  preheader: string;
  /** Large heading at the top of the panel. */
  heading: string;
  /** Body paragraphs, plain text — escaped and wrapped for you. */
  paragraphs: string[];
  /** Optional label/value block, e.g. When / Who / Duration. */
  rows?: EmailRow[];
  /**
   * Headline numbers, laid out as boxes across the panel.
   *
   * Two or three per row — four in a 600px email leaves each box too narrow for
   * a thousands-separated figure, and Outlook will not wrap a table cell to
   * rescue it.
   */
  metrics?: EmailMetric[];
  /** Report body: several headed blocks, in order. */
  sections?: EmailSection[];
  /** Optional primary call to action. */
  button?: EmailButton;
  /** Small print under the panel, above the wordmark. */
  footNote?: string;

  // ---- Workspace identity (P2/6, completed in audit-v2 item 6) ------------
  /**
   * The sending workspace's brand. Preferred over the four fields below, which
   * remain for callers that only know a name.
   *
   * The defaults resolve to VENTURE_BRAND — the SEED, read from the brand
   * module rather than written here as a literal. That distinction is the whole
   * point: an unconfigured workspace still sends exactly what it sent before,
   * and there is no brand string in this template for a second workspace's
   * email to accidentally inherit.
   */
  brand?: WorkspaceBrand;
  /** Signature line on the plain-text part. */
  brandName?: string;
  brandMarkBold?: string;
  brandMarkLight?: string;
  /** Legal identity line in the footer. */
  brandFooter?: string;
}

/** Resolve the four identity strings from whichever form the caller used. */
function identityOf(o: BrandEmailOptions) {
  const brand = o.brand ?? VENTURE_BRAND;
  return {
    name: o.brandName ?? brand.name,
    markBold: o.brandMarkBold ?? brand.markBold,
    markLight: o.brandMarkLight ?? brand.markLight,
    footer: o.brandFooter ?? brandFooterLine(brand),
    accent: brand.color,
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The plain-text alternative. Always send it alongside the HTML: some clients
 * prefer it, and a text part measurably helps deliverability.
 */
export function brandEmailText(o: BrandEmailOptions): string {
  const lines: string[] = [o.heading, ""];
  for (const p of o.paragraphs) lines.push(p, "");
  if (o.metrics?.length) {
    for (const m of o.metrics) {
      lines.push(`${m.label}: ${m.value}${m.hint ? ` (${m.hint})` : ""}`);
    }
    lines.push("");
  }
  if (o.rows?.length) {
    for (const r of o.rows) lines.push(`${r.label}: ${r.value}`);
    lines.push("");
  }
  for (const sec of o.sections ?? []) {
    lines.push(sec.heading.toUpperCase(), "");
    for (const par of sec.paragraphs ?? []) lines.push(par, "");
    for (const b of sec.bullets ?? []) lines.push(`  · ${b}`);
    if (sec.bullets?.length) lines.push("");
    for (const r of sec.rows ?? []) lines.push(`  ${r.label}: ${r.value}`);
    if (sec.rows?.length) lines.push("");
  }
  if (o.button) lines.push(`${o.button.label}: ${o.button.url}`, "");
  if (o.footNote) lines.push(o.footNote, "");
  lines.push(`— ${identityOf(o).name}`);
  return lines.join("\n");
}

export function brandEmail(o: BrandEmailOptions): string {
  const brand = o.brand ?? VENTURE_BRAND;
  const pal = paletteOf(brand);
  const font = emailFont(brand);
  const paragraphs = o.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-family:${font};font-size:15px;line-height:1.6;color:${pal.ink};">${escapeHtml(
          p,
        )}</p>`,
    )
    .join("");

  const rows = o.rows?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0 4px;border-collapse:collapse;">` +
      o.rows
        .map(
          (r) =>
            `<tr>` +
            `<td style="padding:8px 0;border-bottom:1px solid ${pal.border};font-family:${font};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${pal.muted};white-space:nowrap;">${escapeHtml(
              r.label,
            )}</td>` +
            `<td style="padding:8px 0 8px 16px;border-bottom:1px solid ${pal.border};font-family:${font};font-size:14px;font-weight:600;color:${pal.ink};text-align:right;">${escapeHtml(
              r.value,
            )}</td>` +
            `</tr>`,
        )
        .join("") +
      `</table>`
    : "";

  /**
   * Metrics as a row of boxes.
   *
   * Chunked into rows of at most three, each row its own table: a single table
   * with a `colspan` juggle is where Outlook's column widths come apart, and a
   * report that arrives with the numbers stacked on top of each other is worse
   * than one that never had boxes.
   */
  const metricRows: string[] = [];
  for (let i = 0; i < (o.metrics?.length ?? 0); i += 3) {
    const chunk = o.metrics!.slice(i, i + 3);
    const width = Math.floor(100 / chunk.length);
    metricRows.push(
      // The gap lives in the CELL's padding and the box's border on an inner
      // div, rather than in `border-spacing`: spacing is added OUTSIDE the
      // percentage widths, so three 33% cells plus four gaps overflow, the
      // browser shrinks them, and the row ends short of the panel's right edge.
      // This way the boxes line up with the panel on both sides exactly.
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:4px 0 14px;">` +
        `<tr>` +
        chunk
          .map(
            (m, idx) =>
              `<td width="${width}%" valign="top" style="width:${width}%;padding:0 ${idx === chunk.length - 1 ? 0 : 8}px 0 0;">` +
              `<div style="background-color:${pal.canvas};border:1px solid ${pal.border};border-radius:11px;padding:14px 12px;">` +
              `<div style="font-family:${font};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${pal.muted};padding-bottom:6px;">${escapeHtml(
                m.label,
              )}</div>` +
              `<div style="font-family:${font};font-size:24px;font-weight:700;line-height:1.15;color:${pal.ink};">${escapeHtml(
                m.value,
              )}</div>` +
              (m.hint
                ? `<div style="font-family:${font};font-size:11px;line-height:1.4;color:${pal.muted};padding-top:4px;">${escapeHtml(
                    m.hint,
                  )}</div>`
                : "") +
              `</div></td>`,
          )
          .join("") +
        `</tr></table>`,
    );
  }
  const metrics = metricRows.join("");

  const sections = (o.sections ?? [])
    .map((sec) => {
      const inner =
        `<div style="font-family:${font};font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${pal.muted};padding-bottom:8px;">` +
        `${escapeHtml(sec.heading)}</div>` +
        (sec.paragraphs ?? [])
          .map(
            (par) =>
              `<p style="margin:0 0 10px;font-family:${font};font-size:14px;line-height:1.6;color:${pal.ink};">${escapeHtml(
                par,
              )}</p>`,
          )
          .join("") +
        ((sec.bullets ?? []).length
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">` +
            sec
              .bullets!.map(
                (b) =>
                  `<tr>` +
                  `<td valign="top" style="padding:0 8px 7px 0;font-family:${font};font-size:14px;line-height:1.5;color:${pal.accent};">&bull;</td>` +
                  `<td valign="top" style="padding:0 0 7px;font-family:${font};font-size:14px;line-height:1.55;color:${pal.ink};">${escapeHtml(
                    b,
                  )}</td>` +
                  `</tr>`,
              )
              .join("") +
            `</table>`
          : "") +
        ((sec.rows ?? []).length
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">` +
            sec
              .rows!.map(
                (r) =>
                  `<tr>` +
                  `<td style="padding:7px 0;border-bottom:1px solid ${pal.border};font-family:${font};font-size:13px;color:${pal.muted};">${escapeHtml(
                    r.label,
                  )}</td>` +
                  `<td style="padding:7px 0 7px 16px;border-bottom:1px solid ${pal.border};font-family:${font};font-size:13px;font-weight:600;color:${pal.ink};text-align:right;white-space:nowrap;">${escapeHtml(
                    r.value,
                  )}</td>` +
                  `</tr>`,
              )
              .join("") +
            `</table>`
          : "");
      return sec.emphasis
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 4px;"><tr>` +
            `<td style="background-color:${pal.canvas};border:1px solid ${pal.accent};border-radius:11px;padding:16px;">${inner}</td>` +
            `</tr></table>`
        : `<div style="margin:18px 0 4px;">${inner}</div>`;
    })
    .join("");

  // Bulletproof-ish button: a padded table cell, so it renders without relying
  // on border-radius or background-image support.
  const button = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;">` +
      `<tr><td align="center" bgcolor="${pal.accent}" style="border-radius:10px;background-color:${pal.accent};background-image:${pal.gradient};">` +
      `<a href="${escapeHtml(o.button.url)}" style="display:inline-block;padding:12px 22px;font-family:${font};font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(
        o.button.label,
      )}</a>` +
      `</td></tr></table>`
    : "";

  const footNote = o.footNote
    ? `<p style="margin:16px 0 0;font-family:${font};font-size:12px;line-height:1.5;color:${pal.muted};">${escapeHtml(
        o.footNote,
      )}</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(o.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${pal.canvas};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(
    o.preheader,
  )}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${pal.canvas};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;">

      <tr><td style="padding:0 0 18px;font-family:${font};font-size:17px;color:${pal.ink};">
        <span style="font-weight:800;">${escapeHtml(identityOf(o).markBold)}</span><span style="font-weight:300;color:${pal.muted};"> ${escapeHtml(identityOf(o).markLight)}</span>
      </td></tr>

      <tr><td style="background-color:${pal.panel};border:1px solid ${pal.border};border-radius:14px;padding:28px;">
        <h1 style="margin:0 0 14px;font-family:${font};font-size:22px;line-height:1.3;font-weight:700;color:${pal.ink};">${escapeHtml(
          o.heading,
        )}</h1>
        ${paragraphs}
        ${metrics}
        ${rows}
        ${sections}
        ${button}
      </td></tr>

      <tr><td style="padding:14px 4px 0;">
        ${footNote}
        <p style="margin:14px 0 0;font-family:${font};font-size:11px;line-height:1.5;color:${pal.muted};">
          ${escapeHtml(identityOf(o).footer)} · this message was sent because of a
          direct interaction with us.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}
