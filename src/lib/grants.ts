/**
 * Capability grants (spec §3). Layered on top of roles, assignable per user per
 * workspace. Default: all documents.* and templates.* belong to Owner only;
 * Fanni (BDR) gets none until explicitly granted. Checked server-side on every
 * mutation (CLAUDE.md hard rule #7).
 */
export const GRANTS = [
  "documents.quote.create",
  "documents.contract.create",
  "documents.certificate.create",
  "documents.send",
  "templates.edit",
  "signal_engine.approve",
  "exports.run",
] as const;

export type Grant = (typeof GRANTS)[number];

/** Owner's default grant set: everything. */
export const OWNER_GRANTS: Grant[] = [...GRANTS];
