/**
 * Which lead a conversation belongs to (playbook-v2 P2a).
 *
 * Precedence, strongest first:
 *
 *   1. a LEARNED link — someone linked this address by hand once, and that
 *      correction outranks anything we can infer;
 *   2. an exact address on a lead;
 *   3. the company's domain;
 *   4. unmatched.
 *
 * Domain is last and weakest on purpose: `@nagyceg.hu` may be five different
 * people, only one of whom is our contact. A domain match is a guess, it is
 * labelled as one, and one manual correction promotes it to a learned link
 * permanently.
 *
 * Pure over an index the caller builds, so every precedence rule is testable
 * without a database — and so the matcher can run over a thread's participants
 * without touching the network mid-sync.
 */
export type MatchType = "address" | "domain" | "manual";

export interface MatchTarget {
  leadId: string | null;
  companyId: string | null;
}

export interface MatchIndex {
  /** email → target, from lead/company records. */
  byAddress: Map<string, MatchTarget>;
  /** registrable domain → target, from company records. */
  byDomain: Map<string, MatchTarget>;
  /** email → target, from AddressLink. Wins over everything. */
  learned: Map<string, MatchTarget>;
  /** The mailbox owner's own addresses, which match nothing. */
  self: Set<string>;
}

export interface MatchResult extends MatchTarget {
  matchType: MatchType;
  /** Which participant address produced the match, for the UI. */
  via: string;
}

export function normalizeAddress(raw: string): string {
  return (raw ?? "").trim().toLowerCase();
}

/** The domain part, lower-cased and without a leading www. */
export function domainOf(address: string): string | null {
  const at = normalizeAddress(address).lastIndexOf("@");
  if (at === -1) return null;
  const domain = normalizeAddress(address).slice(at + 1).replace(/^www\./, "");
  return domain.includes(".") ? domain : null;
}

/**
 * Free-mail domains never identify a company.
 *
 * Without this, one lead with a gmail.com address would match every private
 * conversation in the mailbox by domain — which is both wrong and the exact
 * privacy failure this feature must not have.
 */
export const GENERIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "freemail.hu",
  "citromail.hu",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "protonmail.com",
  "proton.me",
  "t-online.hu",
  "vipmail.hu",
  "indamail.hu",
]);

export function isGenericDomain(domain: string | null): boolean {
  return domain !== null && GENERIC_DOMAINS.has(domain);
}

export function emptyIndex(): MatchIndex {
  return {
    byAddress: new Map(),
    byDomain: new Map(),
    learned: new Map(),
    self: new Set(),
  };
}

/**
 * Match a thread by its participants.
 *
 * The mailbox owner's own addresses are excluded first — otherwise every
 * thread matches "us" and the whole index is meaningless.
 */
export function matchParticipants(
  participants: string[],
  index: MatchIndex,
): MatchResult | null {
  const addresses = participants
    .map(normalizeAddress)
    .filter((a) => a.includes("@") && !index.self.has(a));
  if (addresses.length === 0) return null;

  for (const address of addresses) {
    const learned = index.learned.get(address);
    if (learned) return { ...learned, matchType: "manual", via: address };
  }

  for (const address of addresses) {
    const exact = index.byAddress.get(address);
    if (exact) return { ...exact, matchType: "address", via: address };
  }

  for (const address of addresses) {
    const domain = domainOf(address);
    if (!domain || isGenericDomain(domain)) continue;
    const byDomain = index.byDomain.get(domain);
    if (byDomain) return { ...byDomain, matchType: "domain", via: address };
  }

  return null;
}

/**
 * Everything the sync is allowed to ask Gmail about.
 *
 * This is the privacy boundary in one function: the search query is built ONLY
 * from what comes back here, so a mailbox is never queried for anything the CRM
 * does not already know about.
 */
export interface SyncScope {
  addresses: string[];
  domains: string[];
}

export function scopeFromIndex(index: MatchIndex): SyncScope {
  const addresses = new Set<string>();
  for (const a of index.byAddress.keys()) addresses.add(a);
  for (const a of index.learned.keys()) addresses.add(a);
  for (const own of index.self) addresses.delete(own);

  const domains = new Set<string>();
  for (const d of index.byDomain.keys()) {
    if (!isGenericDomain(d)) domains.add(d);
  }

  return {
    addresses: [...addresses].sort(),
    domains: [...domains].sort(),
  };
}
