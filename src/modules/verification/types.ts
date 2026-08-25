/**
 * Email verification (playbook-v3 P9/2).
 *
 * ── WHY IT EXISTS AND WHAT IT IS NOT ────────────────────────────────────────
 *
 * Cold email lives or dies on bounce rate: a few dead addresses in an early
 * campaign cost the SENDING DOMAIN's reputation, which is not recoverable by
 * apologising. The circuit breaker already stops a campaign that is bouncing —
 * but by then the damage is done. This is the check that happens BEFORE.
 *
 * It is deliberately not an SMTP prober. Connecting to somebody's mail server
 * to ask whether a mailbox exists is rude, frequently blocked, and generates
 * the exact traffic pattern that gets an IP listed. Everything here is either
 * local text work or a public DNS record, plus an OPTIONAL paid provider behind
 * an adapter for whoever wants one.
 */

export type VerifyStatus = "valid" | "risky" | "invalid" | "unknown";

/** Why the verifier decided what it decided — shown to the operator verbatim. */
export type VerifyReason =
  | "ok"
  | "syntax"
  | "disposable"
  | "role_address"
  | "no_mx"
  | "domain_not_found"
  | "dns_unavailable"
  | "provider_invalid"
  | "provider_risky"
  | "provider_unknown"
  | "suppressed";

export interface VerifyResult {
  status: VerifyStatus;
  reason: VerifyReason;
  /** Normalised address, or null when it is not an address at all. */
  address: string | null;
  checkedAt: Date;
}

export const REASON_TEXT: Record<VerifyReason, string> = {
  ok: "Deliverable as far as we can tell.",
  syntax: "Not a valid email address.",
  disposable: "Throwaway-mailbox domain.",
  role_address: "Role address (info@, office@) — reaches a shared inbox, not a person.",
  no_mx: "The domain has no mail server.",
  domain_not_found: "The domain does not exist.",
  dns_unavailable: "Could not reach DNS — try again.",
  provider_invalid: "The verifier says this mailbox does not exist.",
  provider_risky: "The verifier is not sure — catch-all or full mailbox.",
  provider_unknown: "The verifier could not decide.",
  suppressed: "On the suppression list.",
};

/**
 * Re-verify after this long. An address that resolved three months ago is not
 * evidence about today: companies fold, domains lapse, people leave.
 */
export const REVERIFY_AFTER_DAYS = 90;

export function isStale(checkedAt: Date | null, now: Date = new Date()): boolean {
  if (!checkedAt) return true;
  return now.getTime() - checkedAt.getTime() > REVERIFY_AFTER_DAYS * 24 * 60 * 60 * 1000;
}
