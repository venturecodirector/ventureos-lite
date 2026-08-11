/**
 * Per-workspace retention policy (spec §10 / §4.24). Stored on
 * Workspace.featureFlags.retention with safe defaults. Pure parsing so it is
 * shared by the erasure/anonymization jobs, the admin UI, and tests.
 */
export interface RetentionPolicy {
  anonymizeAfterDays: number; // inactivity window before pseudonymization
  eraseDocumentsOnErasure: boolean; // purge legal docs on lead erasure vs. retain
  backupRotationDays: number; // documented in DEPLOY.md; backups expire within this
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  anonymizeAfterDays: 365,
  eraseDocumentsOnErasure: false, // legal documents retained under legal basis by default
  backupRotationDays: 14,
};

export function parseRetention(input: {
  retentionDays?: number | null;
  featureFlags?: unknown;
}): RetentionPolicy {
  const flags =
    input.featureFlags && typeof input.featureFlags === "object" && !Array.isArray(input.featureFlags)
      ? (input.featureFlags as Record<string, unknown>)
      : {};
  const r =
    flags.retention && typeof flags.retention === "object" && !Array.isArray(flags.retention)
      ? (flags.retention as Record<string, unknown>)
      : {};
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    anonymizeAfterDays: num(r.anonymizeAfterDays, input.retentionDays ?? DEFAULT_RETENTION.anonymizeAfterDays),
    eraseDocumentsOnErasure:
      typeof r.eraseDocumentsOnErasure === "boolean"
        ? r.eraseDocumentsOnErasure
        : DEFAULT_RETENTION.eraseDocumentsOnErasure,
    backupRotationDays: num(r.backupRotationDays, DEFAULT_RETENTION.backupRotationDays),
  };
}
