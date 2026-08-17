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
  /** Captured from a profile page (P1/1e) — personal data like any other. */
  bio: string | null;
  personBrief: string | null;
  avatarPath: string | null;
  anonymizedAt: Date | null;
}

export interface AnonymizedPatch {
  contactName: string;
  email: null;
  phone: null;
  linkedinUrl: null;
  notes: null;
  bio: null;
  personBrief: null;
  avatarPath: null;
  /**
   * Owner-defined values go too (v2 P5/1). A custom field is free-form by
   * construction — whatever a workspace decided to record about a person ends
   * up here, so keeping it would defeat the anonymization entirely. Cleared
   * wholesale rather than field by field, because a definition can be added
   * after the sweep last ran and there is no list of "safe" custom fields.
   */
  customFields: null;
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
    // The captured photo, About text and generated brief are all about a
    // person; anonymization drops them with everything else (P1/1f). The
    // avatar FILE is unlinked by the caller — clearing the path alone would
    // leave the bytes on disk.
    bio: null,
    personBrief: null,
    avatarPath: null,
    customFields: null,
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
