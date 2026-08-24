import { normalizeDomain } from "../leads/dedupe";
import { normalizePhone as canonicalPhone } from "../capture/contact";

/**
 * "Add as lead" dedupe (spec §4.3).
 *
 * Three keys, strongest first:
 *
 *   1. Google's place id — EXACT, and the only key that works on the businesses
 *      this tool exists to find. Of the 71 companies prospected here, one has a
 *      website; a café with no site and no listed number matched nothing at all
 *      and could be added over and over with no warning.
 *   2. website domain
 *   3. phone number
 *
 * (Adószám becomes a strong key once registry enrichment lands, §4.19.)
 */

/**
 * Compare phone numbers by their canonical form, not by their digits.
 *
 * The digits-only version this used to do was wrong in a way that let real
 * duplicates through: Places hands back "06 30 130 2223" while site enrichment
 * writes "+36301302223" onto the same company, and stripping non-digits leaves
 * "06301302223" against "36301302223" — different strings for one phone. Both
 * sides are normalised at COMPARE time, so rows already stored in either format
 * still match.
 */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const canonical = canonicalPhone(phone).value;
  if (canonical) return canonical;
  // Not a number we can canonicalise (a foreign one, say) — fall back to digits
  // so it is still compared against itself rather than ignored.
  const digits = phone.replace(/\D/g, "");
  return digits.length ? digits : null;
}

export interface ProspectKeys {
  placeId?: string | null;
  domain?: string | null;
  phone?: string | null;
}

export interface ExistingCompany extends ProspectKeys {
  id: string;
}

export function findProspectDuplicate<E extends ExistingCompany>(
  candidate: ProspectKeys,
  existing: E[],
): E | null {
  const cid = candidate.placeId?.trim() || null;
  const cd = normalizeDomain(candidate.domain);
  const cp = normalizePhone(candidate.phone);

  // The exact key gets its own pass: a place-id match is a match even if the
  // business has since changed its phone number or put up a website.
  if (cid) {
    const exact = existing.find((e) => (e.placeId?.trim() || null) === cid);
    if (exact) return exact;
  }

  for (const e of existing) {
    const ed = normalizeDomain(e.domain);
    const ep = normalizePhone(e.phone);
    if (cd && ed && cd === ed) return e;
    if (cp && ep && cp === ep) return e;
  }
  return null;
}
