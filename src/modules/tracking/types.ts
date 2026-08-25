/**
 * The signal layer's vocabulary (playbook-v3 P8).
 *
 * ── WHY THIS IS MEASUREMENT AND NOT TRACKING ────────────────────────────────
 *
 * Written down here rather than in a policy document, because the distinction
 * is enforced by the code and counsel will want to check the code:
 *
 *   - No cookie is set, anywhere. Continuity inside one reading session comes
 *     from a random token in sessionStorage, which the browser discards when the
 *     tab closes. Nothing identifies a person across sessions, and nothing
 *     identifies them across sites — the script is served from our own domain
 *     and runs only on pages we published ourselves.
 *   - The raw IP address is held for at most 24 hours, for one purpose: a
 *     reverse-DNS lookup that may name the visiting COMPANY. What survives is a
 *     salted hash and that company guess. The nightly purge enforces the 24
 *     hours and a test asserts it.
 *   - Do-Not-Track and Global-Privacy-Control are honoured at the source: those
 *     visitors send one bare view and the server stores nothing else — no
 *     duration, no sections, no address, not even a hash.
 *   - Identification is at COMPANY level and never presented as a fact. Below
 *     "high" the UI says "valószínűleg".
 *
 * Because no cookie is set and nothing is shared with a third party, the pages
 * carry a notice line rather than a consent banner.
 */

export const PAGE_TYPES = ["audit_share", "quote", "booking", "public_audit"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  audit_share: "Audit report",
  quote: "Quote",
  booking: "Booking page",
  public_audit: "Self-serve audit",
};

export type Confidence = "high" | "medium" | "low" | "none";

/** Only these ever become a VisitorSignal — a guess is not an event. */
export const SIGNAL_CONFIDENCES: readonly Confidence[] = ["high", "medium"];

export interface TrackBeacon {
  /** sessionStorage token. */
  t: string;
  p: string;
  s: string;
  r?: string;
  v?: string;
  d?: number;
  sd?: number;
  sec?: Record<string, number>;
  dnt?: number;
}

/** What a page hands the tracker, resolved from its slug. */
export interface PageTarget {
  workspaceId: string;
  leadId: string | null;
  companyId: string | null;
  documentId: string | null;
  auditId: string | null;
}

