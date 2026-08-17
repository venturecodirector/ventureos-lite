/**
 * Finding duplicates (playbook-v2 P5/2). Pure — the confidence rules are the
 * whole feature, and they have to be provable without a database.
 *
 * Three signals, in descending order of certainty:
 *   1. the same TAX ID. An adószám identifies a legal entity; two rows carrying
 *      one are the same company, full stop.
 *   2. the same DOMAIN. Strong, but not certain — a holding company and its
 *      subsidiary can share a website.
 *   3. a FUZZY-SAME NAME. Suggestive only. "Danubia Kft" and "Danubia Kft."
 *      almost certainly are; "Alfa Bt" and "Alfa Kft" quite possibly are not.
 *
 * Nothing here merges anything. It produces candidates for a person to look at,
 * because the cost of a wrong merge is far higher than the cost of a duplicate
 * sitting in a list.
 */

import { foldText, similarity } from "../search/fuzzy";
import { normalizeTaxId } from "../registry/dedupe";
import { normalizeDomain } from "../leads/dedupe";

export type MatchReason = "tax_id" | "domain" | "name";

export interface DuplicateCandidate {
  aId: string;
  bId: string;
  reason: MatchReason;
  /** 0-100. Certainty, not similarity: a tax id match is 100 by definition. */
  confidence: number;
  detail: string;
}

export interface CompanyLike {
  id: string;
  name: string;
  domain: string | null;
  taxId: string | null;
  createdAt: Date;
  mergedIntoId?: string | null;
}

export interface LeadLike {
  id: string;
  contactName: string | null;
  email: string | null;
  companyId: string | null;
  createdAt: Date;
  mergedIntoId?: string | null;
}

/**
 * Below this, two names are simply two names. Tuned against Hungarian company
 * names, where the legal-form suffix does most of the visual work: dropping it
 * before comparing is what stops "Alfa Kft" and "Beta Kft" scoring 0.7 on the
 * strength of a shared suffix.
 */
export const NAME_THRESHOLD = 0.88;

/** Legal forms carry no identifying information; strip them before comparing. */
const LEGAL_FORMS = [
  "kft",
  "bt",
  "zrt",
  "nyrt",
  "kkt",
  "ev",
  "gmbh",
  "ltd",
  "limited",
  "inc",
  "llc",
  "sro",
  "ag",
  "bv",
];

export function normalizeCompanyName(name: string): string {
  const folded = foldText(name).replace(/[.,]/g, " ");
  const words = folded.split(/\s+/).filter((w) => w && !LEGAL_FORMS.includes(w));
  return words.join(" ").trim();
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Duplicate candidates among companies.
 *
 * A pair is reported ONCE, under its strongest reason: a pair that shares both
 * a tax id and a domain is one duplicate, not two, and listing it twice would
 * make the queue look worse than the data is.
 *
 * Tombstoned rows are excluded — a record that has already been merged away is
 * not a duplicate of anything, it is the resolution of one.
 */
export function findCompanyDuplicates(companies: CompanyLike[]): DuplicateCandidate[] {
  const live = companies.filter((c) => !c.mergedIntoId);
  const seen = new Set<string>();
  const out: DuplicateCandidate[] = [];

  const add = (a: CompanyLike, b: CompanyLike, c: Omit<DuplicateCandidate, "aId" | "bId">) => {
    const key = pairKey(a.id, b.id);
    if (seen.has(key)) return;
    seen.add(key);
    // Oldest first: the survivor default is the record that has been around
    // longer, which is the one other systems are more likely to know about.
    const [older, newer] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
    out.push({ aId: older.id, bId: newer.id, ...c });
  };

  const byTax = new Map<string, CompanyLike[]>();
  const byDomain = new Map<string, CompanyLike[]>();
  for (const c of live) {
    const tax = normalizeTaxId(c.taxId ?? undefined);
    if (tax) byTax.set(tax, [...(byTax.get(tax) ?? []), c]);
    const domain = normalizeDomain(c.domain ?? undefined);
    if (domain) byDomain.set(domain, [...(byDomain.get(domain) ?? []), c]);
  }

  for (const [tax, group] of byTax) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        add(group[i], group[j], {
          reason: "tax_id",
          confidence: 100,
          detail: `Same tax id ${tax}`,
        });
      }
    }
  }

  for (const [domain, group] of byDomain) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        add(group[i], group[j], {
          reason: "domain",
          confidence: 80,
          detail: `Same domain ${domain}`,
        });
      }
    }
  }

  // Names last, and only for pairs nothing stronger already claimed.
  const named = live
    .map((c) => ({ c, key: normalizeCompanyName(c.name) }))
    .filter((x) => x.key.length >= 3);
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (seen.has(pairKey(named[i].c.id, named[j].c.id))) continue;
      const score = similarity(named[i].key, named[j].key);
      if (score < NAME_THRESHOLD) continue;
      add(named[i].c, named[j].c, {
        reason: "name",
        confidence: Math.round(score * 70),
        detail: `Similar name — “${named[i].c.name}” and “${named[j].c.name}”`,
      });
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Duplicate candidates among leads.
 *
 * Narrower than the company rules on purpose: two people at the same company
 * with similar names are usually two people. Only an identical email address,
 * or a fuzzy-same name AT THE SAME COMPANY, is worth surfacing.
 */
export function findLeadDuplicates(leads: LeadLike[]): DuplicateCandidate[] {
  const live = leads.filter((l) => !l.mergedIntoId);
  const seen = new Set<string>();
  const out: DuplicateCandidate[] = [];

  const add = (a: LeadLike, b: LeadLike, c: Omit<DuplicateCandidate, "aId" | "bId">) => {
    const key = pairKey(a.id, b.id);
    if (seen.has(key)) return;
    seen.add(key);
    const [older, newer] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
    out.push({ aId: older.id, bId: newer.id, ...c });
  };

  const byEmail = new Map<string, LeadLike[]>();
  for (const l of live) {
    const email = foldText(l.email ?? "");
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), l]);
  }
  for (const [email, group] of byEmail) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        add(group[i], group[j], {
          reason: "domain",
          confidence: 95,
          detail: `Same email ${email}`,
        });
      }
    }
  }

  const named = live
    .map((l) => ({ l, key: foldText(l.contactName ?? "") }))
    .filter((x) => x.key.length >= 3 && x.l.companyId);
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (named[i].l.companyId !== named[j].l.companyId) continue;
      if (seen.has(pairKey(named[i].l.id, named[j].l.id))) continue;
      const score = similarity(named[i].key, named[j].key);
      if (score < NAME_THRESHOLD) continue;
      add(named[i].l, named[j].l, {
        reason: "name",
        confidence: Math.round(score * 70),
        detail: `Similar name at the same company — “${named[i].l.contactName}” and “${named[j].l.contactName}”`,
      });
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

// ---- field resolution ------------------------------------------------------

export type FieldChoice = "survivor" | "loser";

/**
 * The smart default per field: a non-empty value beats an empty one; between
 * two non-empty values, the NEWER record's wins.
 *
 * "Newer wins" rather than "survivor wins" because the survivor is usually the
 * older record — chosen for its id, not for its freshness — and the whole point
 * of showing the comparison is that the newer row often has the corrected phone
 * number.
 */
export function defaultChoice(
  survivorValue: unknown,
  loserValue: unknown,
  opts: { loserIsNewer: boolean },
): FieldChoice {
  const empty = (v: unknown) =>
    v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  if (empty(loserValue)) return "survivor";
  if (empty(survivorValue)) return "loser";
  return opts.loserIsNewer ? "loser" : "survivor";
}
