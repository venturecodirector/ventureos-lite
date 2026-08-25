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
 * The capabilities that stay behind an explicit grant, whatever the role.
 *
 * ── WHY THESE AND NOT THE OTHERS ───────────────────────────────────────────
 *
 * A quote, a contract and a completion certificate are the documents this
 * business is bound by; sending one puts the company's name behind a number.
 * `templates.edit` is the same power one step back — it decides what every
 * future document SAYS, so granting it is granting all of them.
 *
 * Everything else on the list is ordinary daily work that a BDR was being
 * stopped from doing for no reason anybody could name.
 */
export const DOCUMENT_GRANTS: Grant[] = [
  "documents.quote.create",
  "documents.contract.create",
  "documents.certificate.create",
  "documents.send",
  "templates.edit",
];

/**
 * Pure grant resolution. Lives here, not in authz.ts, so the rule can be
 * imported and unit-tested without pulling in Auth.js and the request-scoped
 * session.
 *
 * Owner and Admin carry everything. A BDR carries everything EXCEPT the
 * document capabilities, which still have to be handed over one by one — and
 * user management, which is not a grant at all: it is Owner-only through
 * `requireOwner`, so no role short of Owner reaches it.
 *
 * That is a deliberate widening. A BDR previously needed an explicit grant to
 * run an export, approve a signal, add a workspace field or merge two obvious
 * duplicates — daily work, gated as if it were a legal document.
 */
export function grantAllowed(role: string, grants: string[], grant: string): boolean {
  if (role === "OWNER" || role === "ADMIN") return true;
  if (role === "BDR" && !DOCUMENT_GRANTS.includes(grant as Grant)) return true;
  return grants.includes(grant);
}

/**
 * A seated member of the workspace, as opposed to somebody merely signed in.
 *
 * Gates the shared furniture: curating saved lead views, approving content,
 * running the prospect backfill, seeing the Owner-only notification types.
 * Every role that exists today qualifies — the predicate stays because the
 * answer belongs in ONE place, so a read-only role can be introduced later with
 * a single edit rather than a hunt through five files.
 */
export function isTrustedMember(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "BDR";
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
