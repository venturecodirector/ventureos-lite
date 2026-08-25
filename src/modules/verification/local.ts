import { normalizeEmail } from "@/modules/capture/contact";
import { DISPOSABLE_DOMAINS } from "./disposable";
import type { VerifyReason } from "./types";

/**
 * The checks that cost nothing (playbook-v3 P9/2, layer 1).
 *
 * Cheapest first, and every one of them is pure — no network, no clock, no
 * database — so the rules are testable and the expensive layers only ever run
 * on addresses that have already earned them.
 */

/**
 * Mailboxes that reach a desk rather than a person.
 *
 * FLAGGED, NOT BLOCKED — the playbook is explicit, and it is right: for a
 * ten-person Hungarian bakery, info@ IS the owner's inbox. Refusing to mail it
 * would refuse the segment. It is risky because a shared inbox is likelier to
 * ignore a cold approach and likelier to mark it as spam, and that is a
 * judgement for the operator, not for the code.
 */
export const ROLE_LOCAL_PARTS = [
  "info", "office", "iroda", "hello", "contact", "kapcsolat", "admin", "sales",
  "support", "help", "team", "mail", "email", "post", "posta", "titkarsag",
  "ugyfelszolgalat", "reception", "recepcio", "noreply", "no-reply", "donotreply",
  "webmaster", "postmaster", "abuse", "billing", "szamlazas", "hr", "jobs", "karrier",
];

/** Addresses nobody reads, ever — these are invalid, not merely risky. */
const NEVER_DELIVERABLE = ["noreply", "no-reply", "donotreply", "postmaster", "abuse"];

export interface LocalVerdict {
  address: string | null;
  domain: string | null;
  localPart: string | null;
  /** Set when the local checks alone settle it. */
  reason: VerifyReason | null;
  isRole: boolean;
}

export function checkLocal(raw: string | null | undefined): LocalVerdict {
  const normalized = normalizeEmail(raw);
  if (!normalized.value) {
    return { address: null, domain: null, localPart: null, reason: "syntax", isRole: false };
  }
  const address = normalized.value;
  const at = address.lastIndexOf("@");
  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (isDisposable(domain)) {
    return { address, domain, localPart, reason: "disposable", isRole: false };
  }

  // A plus-tag or a dot does not change who reads it: info.hu@ and info+x@ are
  // still the shared inbox.
  const bare = localPart.split("+")[0]!.replace(/\./g, "");
  const isRole = ROLE_LOCAL_PARTS.includes(bare);

  if (NEVER_DELIVERABLE.includes(bare)) {
    return { address, domain, localPart, reason: "syntax", isRole: true };
  }

  return { address, domain, localPart, reason: null, isRole };
}

/** Subdomains count: "mail.mailinator.com" is still mailinator. */
export function isDisposable(domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  return DISPOSABLE_DOMAINS.some((entry) => d === entry || d.endsWith(`.${entry}`));
}
