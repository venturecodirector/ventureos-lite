/**
 * Brand layout for transactional email.
 *
 * Every sender built its own `<p>` soup, so booking confirmations, quote
 * notifications and the weekly report all arrived as unstyled browser-default
 * text with no Venture identity on them.
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

const CANVAS = "#00051D";
/** Flattened equivalents of the translucent panel/border tokens over canvas. */
const PANEL = "#0A0F26";
const BORDER = "#1B2138";
const INK = "#EFF1F8";
const MUTED = "#858CAE";
const ACCENT = "#7427C6";
const GRADIENT = "linear-gradient(135deg, #310B59, #7427C6)";

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif";

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailRow {
  label: string;
  value: string;
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
  /** Optional primary call to action. */
  button?: EmailButton;
  /** Small print under the panel, above the wordmark. */
  footNote?: string;
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
  if (o.rows?.length) {
    for (const r of o.rows) lines.push(`${r.label}: ${r.value}`);
    lines.push("");
  }
  if (o.button) lines.push(`${o.button.label}: ${o.button.url}`, "");
  if (o.footNote) lines.push(o.footNote, "");
  lines.push("— Venture CO Group");
  return lines.join("\n");
}

export function brandEmail(o: BrandEmailOptions): string {
  const paragraphs = o.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">${escapeHtml(
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
            `<td style="padding:8px 0;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};white-space:nowrap;">${escapeHtml(
              r.label,
            )}</td>` +
            `<td style="padding:8px 0 8px 16px;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:14px;font-weight:600;color:${INK};text-align:right;">${escapeHtml(
              r.value,
            )}</td>` +
            `</tr>`,
        )
        .join("") +
      `</table>`
    : "";

  // Bulletproof-ish button: a padded table cell, so it renders without relying
  // on border-radius or background-image support.
  const button = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;">` +
      `<tr><td align="center" bgcolor="${ACCENT}" style="border-radius:10px;background-color:${ACCENT};background-image:${GRADIENT};">` +
      `<a href="${escapeHtml(o.button.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(
        o.button.label,
      )}</a>` +
      `</td></tr></table>`
    : "";

  const footNote = o.footNote
    ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">${escapeHtml(
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
<body style="margin:0;padding:0;background-color:${CANVAS};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(
    o.preheader,
  )}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${CANVAS};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;">

      <tr><td style="padding:0 0 18px;font-family:${FONT};font-size:17px;color:${INK};">
        <span style="font-weight:800;">venture</span><span style="font-weight:300;color:${MUTED};"> co.group</span>
      </td></tr>

      <tr><td style="background-color:${PANEL};border:1px solid ${BORDER};border-radius:14px;padding:28px;">
        <h1 style="margin:0 0 14px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(
          o.heading,
        )}</h1>
        ${paragraphs}
        ${rows}
        ${button}
      </td></tr>

      <tr><td style="padding:14px 4px 0;">
        ${footNote}
        <p style="margin:14px 0 0;font-family:${FONT};font-size:11px;line-height:1.5;color:${MUTED};">
          Venture CO Group · Budapest · this message was sent because of a
          direct interaction with us.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}
