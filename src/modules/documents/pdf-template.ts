import { formatHuf, computeLineTotal, type QuoteItem, type QuoteTotals } from "./quote-math";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import { brandBaseCss, brandFooterHtml, brandMarkHtml, brandRootStyle } from "@/modules/workspaces/letterhead";

/**
 * Quote → template data + branded PDF wrapper (spec §4.9). Rendered from the
 * pinned template version + variables only (no AI in the render path). The DRAFT
 * watermark is applied here while the document is unfinalized.
 */
export interface QuotePayload {
  items: QuoteItem[];
  vatRatePct: number;
  validUntil: string;
  quoteNumber: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildItemsTable(items: QuoteItem[]): string {
  const rows = items
    .map(
      (i) =>
        `<tr><td>${esc(i.description)}</td><td style="text-align:right">${formatHuf(
          computeLineTotal(i.baseNet, i.preset),
        )}</td></tr>`,
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse">${rows}</table>`;
}

export interface QuoteContext {
  workspace: { legalName: string; taxId: string; address: string };
  client: { name: string; company: string; taxId: string; address: string };
  date: string;
}

export function buildQuoteData(
  payload: QuotePayload,
  totals: QuoteTotals,
  ctx: QuoteContext,
): Record<string, unknown> {
  return {
    workspace: {
      legal_name: ctx.workspace.legalName,
      tax_id: ctx.workspace.taxId,
      address: ctx.workspace.address,
    },
    client: {
      name: ctx.client.name,
      company: ctx.client.company,
      tax_id: ctx.client.taxId,
      address: ctx.client.address,
    },
    quote: {
      number: payload.quoteNumber,
      date: ctx.date,
      valid_until: payload.validUntil,
      total_net: formatHuf(totals.net),
      vat: `${payload.vatRatePct}%`,
      total_gross: formatHuf(totals.gross),
    },
    items_table: buildItemsTable(payload.items),
  };
}

/**
 * Wrap a rendered template body in the WORKSPACE's letterhead; DRAFT watermark
 * overlay while unfinalized (audit-v2 item 6).
 *
 * Every colour is a `var(--brand-*)` fed from the workspace's configuration.
 * For an unconfigured workspace those variables resolve to the design tokens
 * this template used to name directly, so the output is unchanged.
 */
export function buildDocumentPdfHtml(
  renderedBody: string,
  watermark: boolean,
  brand: WorkspaceBrand,
): string {
  const wm = watermark
    ? `<div class="wm">DRAFT</div>`
    : "";
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--brand-font-body); background: var(--brand-canvas); color: var(--brand-ink); padding: 48px 44px; position: relative; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${brandBaseCss()}
  .brand { margin-bottom: 28px; }
  .doc { position: relative; z-index: 1; font-size: 12.5px; line-height: 1.6; color: #C9CEE3; }
  .doc h1 { font-size: 20px; font-weight: 800; margin-bottom: 10px; color: var(--brand-ink); }
  .doc h2 { font-size: 13px; margin: 14px 0 4px; color: var(--brand-ink); }
  .doc table { margin: 10px 0; }
  .doc td { border-bottom: 1px solid rgba(239,241,248,0.09); padding: 6px 0; }
  .doc hr { margin: 16px 0; border: none; border-top: 1px solid rgba(239,241,248,0.09); }
  .wm { position: fixed; inset: 0; display: grid; place-items: center; z-index: 0; pointer-events: none;
        font-size: 120px; font-weight: 800; letter-spacing: 0.12em; color: rgba(239,241,248,0.05); transform: rotate(-24deg); }
</style></head>
<body style="${brandRootStyle(brand)}">
  ${wm}
  ${brandMarkHtml(brand)}
  <div class="doc">${renderedBody}</div>
  <div class="brand-footer" style="margin-top:28px">${brandFooterHtml(brand)}</div>
</body></html>`;
}
