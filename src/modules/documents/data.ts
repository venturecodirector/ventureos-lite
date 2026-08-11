import { buildQuoteData, type QuotePayload } from "./pdf-template";
import type { QuoteTotals } from "./quote-math";
import type { ContractPayload, CertificatePayload } from "./prefill";

/**
 * Assemble {{variable}} data for a stored document (quote / contract /
 * certificate) from its payload + workspace + client. Shared by the PDF job and
 * the finalization empty-variable check. Deterministic — no AI.
 */
interface DocLike {
  type: string;
  payload: unknown;
  totals: unknown;
  createdAt: Date;
  lead: {
    contactName: string | null;
    company: { name: string; taxId: string | null; address: string | null } | null;
  } | null;
}

interface WorkspaceLike {
  legalName: string | null;
  brand: unknown;
}

function baseData(doc: DocLike, workspace: WorkspaceLike | null) {
  const brand =
    workspace?.brand && typeof workspace.brand === "object" && !Array.isArray(workspace.brand)
      ? (workspace.brand as Record<string, unknown>)
      : {};
  return {
    workspace: {
      legal_name: workspace?.legalName ?? "Venture CO Group",
      tax_id: String(brand.tax_id ?? ""),
      address: String(brand.address ?? ""),
    },
    client: {
      name: doc.lead?.contactName ?? "",
      company: doc.lead?.company?.name ?? "",
      tax_id: doc.lead?.company?.taxId ?? "",
      address: doc.lead?.company?.address ?? "",
    },
  };
}

export function buildDocumentData(
  doc: DocLike,
  workspace: WorkspaceLike | null,
): Record<string, unknown> {
  const base = baseData(doc, workspace);
  const date = doc.createdAt.toISOString().slice(0, 10);

  if (doc.type === "CONTRACT") {
    const p = (doc.payload ?? {}) as Partial<ContractPayload>;
    return {
      ...base,
      contract: {
        scope: p.scope ?? "",
        milestones: p.milestones ?? "",
        payment_terms: p.payment_terms ?? "",
      },
    };
  }
  if (doc.type === "CERTIFICATE") {
    const p = (doc.payload ?? {}) as Partial<CertificatePayload>;
    return {
      ...base,
      certificate: { date: p.date ?? date, deliverables: p.deliverables ?? "" },
    };
  }

  const payload = (doc.payload ?? {}) as unknown as QuotePayload;
  const totals = (doc.totals ?? { net: 0, vat: 0, gross: 0 }) as unknown as QuoteTotals;
  return buildQuoteData(payload, totals, {
    workspace: {
      legalName: base.workspace.legal_name,
      taxId: base.workspace.tax_id,
      address: base.workspace.address,
    },
    client: {
      name: base.client.name,
      company: base.client.company,
      taxId: base.client.tax_id,
      address: base.client.address,
    },
    date,
  });
}
