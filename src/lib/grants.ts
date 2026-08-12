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
