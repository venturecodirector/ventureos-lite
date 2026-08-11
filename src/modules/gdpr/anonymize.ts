/**
 * Lead anonymization (spec §10). Pseudonymizes person fields while keeping the
 * lead row (and its aggregate stats — stage, score, outcomes) intact. Pure and
 * IDEMPOTENT: re-running yields identical output and preserves the original
 * anonymizedAt, so the monthly sweep never drifts.
 */
export interface AnonymizableLead {
  id: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  notes: string | null;
  anonymizedAt: Date | null;
}

export interface AnonymizedPatch {
  contactName: string;
  email: null;
  phone: null;
  linkedinUrl: null;
  notes: null;
  anonymizedAt: Date;
}

/** Deterministic pseudonym derived from the immutable id. */
function pseudonym(id: string): string {
  return `Anonymized-${id.slice(-6)}`;
}

export function pseudonymizeLead(lead: AnonymizableLead, nowMs: number): AnonymizedPatch {
  return {
    contactName: pseudonym(lead.id),
    email: null,
    phone: null,
    linkedinUrl: null,
    notes: null,
    // Preserve the original timestamp so repeated runs are stable.
    anonymizedAt: lead.anonymizedAt ?? new Date(nowMs),
  };
}

export function isAnonymized(lead: { anonymizedAt: Date | null }): boolean {
  return lead.anonymizedAt != null;
}

/** Inactive (before cutoff) and not yet anonymized. Falls back to createdAt. */
export function shouldAnonymize(
  lead: { lastActivityAt: Date | null; createdAt?: Date; anonymizedAt: Date | null },
  cutoffMs: number,
): boolean {
  if (lead.anonymizedAt != null) return false;
  const last = lead.lastActivityAt ?? lead.createdAt ?? null;
  if (!last) return false;
  return last.getTime() < cutoffMs;
}
