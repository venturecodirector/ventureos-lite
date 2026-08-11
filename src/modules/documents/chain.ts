import type { DocumentType, DocumentStatus } from "@prisma/client";

/**
 * Document chain (spec §4.9): quote → contract → certificate. Statuses and
 * unlock rules are deterministic — no AI in the render or chain path.
 */
export const CHAIN_ORDER: DocumentType[] = ["QUOTE", "CONTRACT", "CERTIFICATE"];

export function nextInChain(type: DocumentType): DocumentType | null {
  const i = CHAIN_ORDER.indexOf(type);
  return i >= 0 && i < CHAIN_ORDER.length - 1 ? CHAIN_ORDER[i + 1] : null;
}

/** Contract generation is unlocked by an accepted quote (spec §4.9). */
export function canCreateContract(quoteStatus: DocumentStatus): boolean {
  return quoteStatus === "ACCEPTED";
}

/** Certificate generation is unlocked by a signed contract. */
export function canCreateCertificate(contractStatus: DocumentStatus): boolean {
  return contractStatus === "SIGNED";
}

const TRANSITIONS: Record<DocumentType, Partial<Record<DocumentStatus, DocumentStatus[]>>> = {
  QUOTE: { DRAFT: ["SENT"], SENT: ["ACCEPTED", "DECLINED", "EXPIRED"] },
  CONTRACT: { DRAFT: ["SENT"], SENT: ["SIGNED"] },
  CERTIFICATE: { DRAFT: ["SENT"], SENT: ["ACKNOWLEDGED"] },
};

export function allowedStatusTransition(
  type: DocumentType,
  from: DocumentStatus,
  to: DocumentStatus,
): boolean {
  return (TRANSITIONS[type]?.[from] ?? []).includes(to);
}

export interface ChainDoc {
  type: DocumentType;
  status: DocumentStatus;
}

export interface StepperStep {
  type: DocumentType;
  present: boolean;
  status: DocumentStatus | null;
  active: boolean;
}

export function buildChainStepper(docs: ChainDoc[]): StepperStep[] {
  const byType = new Map(docs.map((d) => [d.type, d]));
  let lastPresent = -1;
  CHAIN_ORDER.forEach((t, i) => {
    if (byType.has(t)) lastPresent = i;
  });
  return CHAIN_ORDER.map((type, i) => ({
    type,
    present: byType.has(type),
    status: byType.get(type)?.status ?? null,
    active: i === lastPresent,
  }));
}
