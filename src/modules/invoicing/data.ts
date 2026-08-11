import type { WorkspaceClient } from "../../lib/db";
import type { QuoteItem } from "../documents/quote-math";
import { buildBuyer, composeInvoicePayload, type InvoicePayload } from "./logic";

/**
 * Compose the invoice payload from an ACKNOWLEDGED completion certificate by
 * walking the document chain up to its quote for the line items (spec §4.23):
 * certificate → contract → quote. Partner data comes from registry enrichment,
 * falling back to the company record.
 */
export interface ComposedInvoice {
  payload: InvoicePayload;
  leadId: string | null;
  quoteNumber: string;
  certificateId: string;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function composeFromCertificate(
  db: WorkspaceClient,
  certificateId: string,
  now: Date,
): Promise<{ ok: true; value: ComposedInvoice } | { ok: false; error: string }> {
  const cert = await db.document.findUnique({
    where: { id: certificateId },
    include: { lead: { include: { company: true } } },
  });
  if (!cert || cert.type !== "CERTIFICATE") return { ok: false, error: "Not a completion certificate." };
  if (cert.status !== "ACKNOWLEDGED") {
    return { ok: false, error: "The certificate must be acknowledged before invoicing." };
  }

  // Walk the chain to the quote for line items.
  let cursor: string | null = cert.chainParentId;
  let quote: { payload: unknown } | null = null;
  for (let i = 0; i < 5 && cursor; i++) {
    const doc: { id: string; type: string; chainParentId: string | null; payload: unknown } | null =
      await db.document.findUnique({
        where: { id: cursor },
        select: { id: true, type: true, chainParentId: true, payload: true },
      });
    if (!doc) break;
    if (doc.type === "QUOTE") {
      quote = { payload: doc.payload };
      break;
    }
    cursor = doc.chainParentId;
  }
  if (!quote) return { ok: false, error: "No quote found in this document's chain." };

  const qp = (quote.payload ?? {}) as { items?: QuoteItem[]; vatRatePct?: number; quoteNumber?: string };
  if (!Array.isArray(qp.items) || qp.items.length === 0) {
    return { ok: false, error: "The quote has no line items." };
  }

  const company = cert.lead?.company ?? null;
  if (!company) return { ok: false, error: "The lead has no company to invoice." };
  const registry = await db.registryData.findUnique({ where: { companyId: company.id } });

  const buyer = buildBuyer(
    registry ? { legalName: registry.legalName, taxId: registry.taxId } : null,
    { name: company.name, address: company.address, city: company.city, taxId: company.taxId, email: cert.lead?.email ?? null },
  );

  const due = new Date(now.getTime() + 14 * 24 * 60 * 60_000);
  const payload = composeInvoicePayload({
    items: qp.items,
    vatRatePct: qp.vatRatePct ?? 27,
    buyer,
    header: {
      issueDate: fmtDate(now),
      fulfillmentDate: fmtDate(now),
      dueDate: fmtDate(due),
      paymentMethod: "Átutalás",
      currency: "HUF",
      language: "hu",
    },
  });

  return {
    ok: true,
    value: { payload, leadId: cert.leadId ?? null, quoteNumber: qp.quoteNumber ?? "", certificateId },
  };
}
