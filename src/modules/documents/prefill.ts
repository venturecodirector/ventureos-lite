import type { QuoteItem } from "./quote-math";

/**
 * Contract/certificate pre-fill (spec §4.9): contract scope from the accepted
 * quote's line items + registry party data; certificate deliverables from the
 * contract scope. Deterministic — no AI (the optional Claude scope paragraph is
 * a separate, labeled, human-approved assist).
 */
export const DEFAULT_MILESTONES = "Terv (2 hét) · Fejlesztés (6 hét) · Élesítés (1 hét)";
export const DEFAULT_PAYMENT_TERMS = "40% előleg a szerződéskötéskor, 60% átadáskor.";

export function contractScopeFromQuote(items: QuoteItem[]): string {
  return items.map((i) => `• ${i.description}`).join("\n");
}

export interface ContractParty {
  clientLegalName: string;
  clientTaxId: string;
  contractorLegalName: string;
}

export interface ContractPayload {
  parties: ContractParty;
  scope: string;
  milestones: string;
  payment_terms: string;
  contractNumber: string;
}

export function contractPayloadFromQuote(
  items: QuoteItem[],
  party: ContractParty,
  contractNumber: string,
  overrides?: { scope?: string; milestones?: string; payment_terms?: string },
): ContractPayload {
  return {
    parties: party,
    scope: overrides?.scope ?? contractScopeFromQuote(items),
    milestones: overrides?.milestones ?? DEFAULT_MILESTONES,
    payment_terms: overrides?.payment_terms ?? DEFAULT_PAYMENT_TERMS,
    contractNumber,
  };
}

export interface CertificatePayload {
  deliverables: string;
  date: string;
  certNumber: string;
}

export function certificatePayloadFromContract(
  contract: { scope: string },
  date: string,
  certNumber: string,
  overrides?: { deliverables?: string },
): CertificatePayload {
  return {
    deliverables: overrides?.deliverables ?? contract.scope,
    date,
    certNumber,
  };
}
