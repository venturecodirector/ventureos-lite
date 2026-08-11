import { formatHuf, computeLineTotal, type QuoteItem, type QuoteTotals } from "./quote-math";

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

/** Wrap a rendered template body in the Venture letterhead; DRAFT watermark
 * overlay while unfinalized. */
export function buildDocumentPdfHtml(renderedBody: string, watermark: boolean): string {
  const wm = watermark
    ? `<div class="wm">DRAFT</div>`
    : "";
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background: #00051D; color: #EFF1F8; padding: 48px 44px; position: relative; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .brand { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 28px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: #858CAE; margin-left: 6px; }
  .doc { position: relative; z-index: 1; font-size: 12.5px; line-height: 1.6; color: #C9CEE3; }
  .doc h1 { font-size: 20px; font-weight: 800; margin-bottom: 10px; color: #EFF1F8; }
  .doc h2 { font-size: 13px; margin: 14px 0 4px; color: #EFF1F8; }
  .doc table { margin: 10px 0; }
  .doc td { border-bottom: 1px solid rgba(239,241,248,0.09); padding: 6px 0; }
  .doc hr { margin: 16px 0; border: none; border-top: 1px solid rgba(239,241,248,0.09); }
  .wm { position: fixed; inset: 0; display: grid; place-items: center; z-index: 0; pointer-events: none;
        font-size: 120px; font-weight: 800; letter-spacing: 0.12em; color: rgba(239,241,248,0.05); transform: rotate(-24deg); }
</style></head>
<body>
  ${wm}
  <div class="brand"><b>venture</b><span>co.group</span></div>
  <div class="doc">${renderedBody}</div>
</body></html>`;
}
