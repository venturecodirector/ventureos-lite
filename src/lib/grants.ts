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
  /// Owner-defined fields (v2 P5/1). Adding a REQUIRED field changes what every
  /// form in the workspace demands and archiving one changes what every table
  /// shows, so the definition set is a capability rather than an edit.
  "fields.manage",
  /// Merging two companies or two leads (v2 P5/2). Irreversible after 30 days,
  /// and it moves every activity, document and deal off one record onto
  /// another — a mistake here is not a typo, it is two clients becoming one.
  "data.merge",
] as const;

export type Grant = (typeof GRANTS)[number];

/** Owner's default grant set: everything. */
export const OWNER_GRANTS: Grant[] = [...GRANTS];

/**
 * Pure grant resolution — Owner/Admin carry everything; everyone else needs the
 * grant explicitly. Lives here, not in authz.ts, so the rule can be imported
 * and unit-tested without pulling in Auth.js and the request-scoped session.
 */
export function grantAllowed(role: string, grants: string[], grant: string): boolean {
  if (role === "OWNER" || role === "ADMIN") return true;
  return grants.includes(grant);
}

/** Raised when a server-side mutation is attempted without its capability. */
export class GrantError extends Error {
  readonly grant: string;
  constructor(grant: string) {
    super(`Missing capability: ${grant}`);
    this.name = "GrantError";
    this.grant = grant;
    Object.setPrototypeOf(this, GrantError.prototype);
  }
}
