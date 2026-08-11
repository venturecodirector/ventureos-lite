import { normalizeDomain } from "../leads/dedupe";

/**
 * "Add as lead" dedupe (spec §4.3). Prospector businesses often have no website
 * (the target rows), so we key on website domain OR phone number. (Adószám
 * becomes the strongest key once registry enrichment lands, §4.19.)
 */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length ? digits : null;
}

export interface ProspectKeys {
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
  const cd = normalizeDomain(candidate.domain);
  const cp = normalizePhone(candidate.phone);
  for (const e of existing) {
    const ed = normalizeDomain(e.domain);
    const ep = normalizePhone(e.phone);
    if (cd && ed && cd === ed) return e;
    if (cp && ep && cp === ep) return e;
  }
  return null;
}
