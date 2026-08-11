import { createHash } from "node:crypto";
import { computeLineTotal, type QuoteItem } from "../documents/quote-math";

/**
 * Számlázz.hu Számla Agent invoice composition + XML build (spec §4.23).
 *
 * API assumptions (verified against docs.szamlazz.hu / Számla Agent, Aug 2026):
 *  - Create invoice: POST https://www.szamlazz.hu/szamla/ as multipart/form-data
 *    with the XML under the field `action-xmlagentxmlfile`.
 *  - XML root <xmlszamla> (namespace http://www.szamlazz.hu/xmlszamla). Element
 *    ORDER IS FIXED: beallitasok → fejlec → elado → vevo → tetelek.
 *  - Auth: <szamlaagentkulcs> inside <beallitasok> (per-workspace agent key).
 *  - Per line: nettoEgysegar·mennyiseg = nettoErtek, and nettoErtek + afaErtek =
 *    bruttoErtek (Számla validates this) — so VAT is rounded PER LINE here.
 *  - Response: success → HTTP header `szlahu_szamlaszam` (invoice no., URL-enc);
 *    error → `szlahu_error_code` + `szlahu_error`. With szamlaLetoltes=true the
 *    body is the PDF binary.
 * All money is integer HUF forints; VAT computed, never floats (CLAUDE.md).
 */

// ---- types ----------------------------------------------------------------

export interface InvoiceBuyer {
  name: string;
  taxId: string;
  postalCode: string;
  city: string;
  address: string;
  email: string;
}

export interface InvoiceHeader {
  issueDate: string;
  fulfillmentDate: string;
  dueDate: string;
  paymentMethod: string;
  currency: string;
  language: string;
}

export interface InvoiceLine {
  name: string;
  quantity: number;
  unit: string;
  netUnitPrice: number;
  vatRate: number;
  netValue: number;
  vatValue: number;
  grossValue: number;
}

export interface InvoicePayload {
  header: InvoiceHeader;
  buyer: InvoiceBuyer;
  lines: InvoiceLine[];
  totals: { net: number; vat: number; gross: number };
}

// ---- partner (buyer) from registry enrichment, falling back to company ----

/** Pull the leading 4-digit Hungarian postal code out of an address string. */
function postalCodeFrom(address: string | null | undefined): string {
  const m = (address ?? "").match(/\b(\d{4})\b/);
  return m ? m[1] : "";
}

export function buildBuyer(
  registry: { legalName?: string | null; taxId?: string | null } | null,
  company: { name: string; address?: string | null; city?: string | null; taxId?: string | null; email?: string | null },
): InvoiceBuyer {
  return {
    name: registry?.legalName || company.name,
    taxId: registry?.taxId || company.taxId || "",
    postalCode: postalCodeFrom(company.address),
    city: company.city ?? "",
    address: company.address ?? "",
    email: company.email ?? "",
  };
}

// ---- payload composition from the chain -----------------------------------

export function composeInvoicePayload(input: {
  items: QuoteItem[];
  vatRatePct: number;
  buyer: InvoiceBuyer;
  header: InvoiceHeader;
}): InvoicePayload {
  const vat = input.vatRatePct;
  const lines: InvoiceLine[] = input.items.map((it) => {
    const netValue = computeLineTotal(it.baseNet, it.preset);
    const vatValue = Math.round((netValue * vat) / 100);
    return {
      name: it.description,
      quantity: 1,
      unit: "db",
      netUnitPrice: netValue, // quantity is 1
      vatRate: vat,
      netValue,
      vatValue,
      grossValue: netValue + vatValue,
    };
  });
  const totals = lines.reduce(
    (t, l) => ({ net: t.net + l.netValue, vat: t.vat + l.vatValue, gross: t.gross + l.grossValue }),
    { net: 0, vat: 0, gross: 0 },
  );
  return { header: input.header, buyer: input.buyer, lines, totals };
}

// ---- confirm-gate ---------------------------------------------------------

export class ConfirmationError extends Error {
  constructor() {
    super("Invoice not confirmed — the payload must be confirmed exactly as shown before submission.");
    this.name = "ConfirmationError";
  }
}

/** Stable SHA-256 over the exact payload the confirmation screen shows. */
export function confirmationHash(payload: InvoicePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Submission may proceed ONLY when the confirmed hash matches the fresh payload. */
export function assertConfirmed(freshPayload: InvoicePayload, providedHash: string): void {
  if (!providedHash || providedHash !== confirmationHash(freshPayload)) {
    throw new ConfirmationError();
  }
}

// ---- XML build ------------------------------------------------------------

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildInvoiceXml(payload: InvoicePayload, agentKey: string): string {
  const { header: h, buyer: b, lines } = payload;
  const tetelek = lines
    .map(
      (l) =>
        `    <tetel>\n` +
        `      <megnevezes>${esc(l.name)}</megnevezes>\n` +
        `      <mennyiseg>${l.quantity}</mennyiseg>\n` +
        `      <mennyisegiEgyseg>${esc(l.unit)}</mennyisegiEgyseg>\n` +
        `      <nettoEgysegar>${l.netUnitPrice}</nettoEgysegar>\n` +
        `      <afakulcs>${l.vatRate}</afakulcs>\n` +
        `      <nettoErtek>${l.netValue}</nettoErtek>\n` +
        `      <afaErtek>${l.vatValue}</afaErtek>\n` +
        `      <bruttoErtek>${l.grossValue}</bruttoErtek>\n` +
        `    </tetel>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla https://www.szamlazz.hu/szamla/docs/xsds/agent/xmlszamla.xsd">
  <beallitasok>
    <szamlaagentkulcs>${esc(agentKey)}</szamlaagentkulcs>
    <eszamla>true</eszamla>
    <szamlaLetoltes>true</szamlaLetoltes>
    <valaszVerzio>1</valaszVerzio>
  </beallitasok>
  <fejlec>
    <keltDatum>${esc(h.issueDate)}</keltDatum>
    <teljesitesDatum>${esc(h.fulfillmentDate)}</teljesitesDatum>
    <fizetesiHataridoDatum>${esc(h.dueDate)}</fizetesiHataridoDatum>
    <fizmod>${esc(h.paymentMethod)}</fizmod>
    <penznem>${esc(h.currency)}</penznem>
    <szamlaNyelve>${esc(h.language)}</szamlaNyelve>
  </fejlec>
  <elado></elado>
  <vevo>
    <nev>${esc(b.name)}</nev>
    <irsz>${esc(b.postalCode)}</irsz>
    <telepules>${esc(b.city)}</telepules>
    <cim>${esc(b.address)}</cim>
    <adoszam>${esc(b.taxId)}</adoszam>
    <email>${esc(b.email)}</email>
  </vevo>
  <tetelek>
${tetelek}
  </tetelek>
</xmlszamla>`;
}

// ---- response parsing -----------------------------------------------------

export interface SzamlaResult {
  ok: boolean;
  invoiceNumber?: string;
  errorCode?: string;
  error?: string;
}

function urlDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseSzamlaResponse(headers: Record<string, string | undefined>): SzamlaResult {
  const code = headers.szlahu_error_code;
  const err = headers.szlahu_error;
  if (code || err) {
    return { ok: false, errorCode: code, error: err ? urlDecode(err) : undefined };
  }
  const num = headers.szlahu_szamlaszam;
  if (num) return { ok: true, invoiceNumber: urlDecode(num) };
  return { ok: false, error: "No invoice number and no error in response" };
}

// ---- failure → Today Queue ------------------------------------------------

export function invoiceFailureActivity(input: {
  documentId: string;
  leadId: string | null;
  kind: "validation" | "network" | "rejected";
  code?: string;
  error?: string;
  raw: string;
}): { type: "invoice_failed"; leadId: string | null; payload: Record<string, unknown> } {
  return {
    type: "invoice_failed",
    leadId: input.leadId,
    payload: {
      documentId: input.documentId,
      kind: input.kind,
      code: input.code ?? null,
      error: input.error ?? null,
      raw: input.raw.slice(0, 8000),
    },
  };
}
