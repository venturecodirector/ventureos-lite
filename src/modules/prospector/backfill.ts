import { normalizePhone } from "@/modules/capture/contact";
import { plausibleTown } from "@/lib/places";
import { normalizeDomain } from "../leads/dedupe";

/**
 * Backfilling the companies prospected before the fixes (P4/1e).
 *
 * ── WHAT IS ACTUALLY MISSING ───────────────────────────────────────────────
 *
 * Seventy-one companies came in through the Prospector before the search asked
 * Google for Hungarian, before the city and the place id were read out of the
 * response at all, and before the site was read for an email address. What that
 * left, counted in production:
 *
 *   69 companies with no city, though every one of them has an address
 *   71 industries in English — eleven "Bakery", four "Cafe", one "Store"
 *   71 leads with no email address whatsoever
 *   13 companies with no phone number, and 10 leads missing one the company has
 *   80 companies with no google_place_id — the only EXACT dedupe key there is
 *
 * Two of those need nobody's API: the town is sitting in the stored address
 * string, and the English category set is closed and small. The rest needs
 * Google to be asked again, once per company, which costs money — so it is a
 * separate, priced, opt-in step, and it never writes anything the operator has
 * not seen first.
 */

export interface BackfillCompany {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  industry: string | null;
  phone: string | null;
  domain: string | null;
  website: string | null;
  /** The lead this company was prospected as — the phone and email live there too. */
  leadPhone: string | null;
  leadEmail: string | null;
}

/** Fold accents and case so "Máthé" and "Mathe" compare equal. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// ---- the town, out of the address we already have -------------------------

/** Country names Google appends; never a town. */
const COUNTRY = /^(hungary|magyarorszag)$/;

/**
 * Words that make a segment a STREET rather than a settlement.
 *
 * "Harminckettesek tere" is a square, "Budapest" is a city, and both arrive as
 * comma-separated segments of the same string with nothing else to tell them
 * apart.
 */
const STREET_WORD =
  /\b(utca|u|ut|utja|krt|korut|ter|tere|kez|koz|fasor|setany|sgt|sugarut|dulo|park|liget|rakpart|sor|udvar|hrsz|puszta|tanya|ltp|lakotelep)\b/;

/**
 * The town from a formatted address.
 *
 * Google writes Hungarian addresses as "Budapest, Wesselényi utca 25, 1077
 * Hungary" — the town is a comma-separated segment that carries no house
 * number and no street word. Postal codes attach to either end of it
 * ("1077 Budapest", "Budapest 1077") and are stripped before the test.
 *
 * Free, deterministic, and it covers every company here whether or not Google
 * can still find the business.
 */
export function townFromAddress(address: string | null): string | null {
  for (const raw of (address ?? "").split(",")) {
    const segment = raw.trim();
    if (!segment) continue;
    const stripped = segment
      .replace(/\b(hungary|magyarország)\b/gi, "")
      .replace(/^\s*\d{4}\s+/, "")
      .replace(/\s+\d{4}\s*$/, "")
      .trim();
    if (!stripped) continue;
    const folded = fold(stripped);
    if (COUNTRY.test(folded)) continue;
    // A house number, a floor, or a street: not the name of a town.
    if (/\d/.test(stripped)) continue;
    if (STREET_WORD.test(folded)) continue;
    if (!plausibleTown(stripped)) continue;
    return stripped;
  }
  return null;
}

// ---- the industry, out of a closed set ------------------------------------

/**
 * Google's English category names, as they actually appear in this workspace's
 * data, mapped to what the Hungarian API returns for the same place.
 *
 * A closed set on purpose: it exists to repair rows fetched before the request
 * asked for Hungarian, and nothing new can arrive in English any more. An
 * unknown value is left ALONE rather than guessed at — a wrong industry is
 * worse than an English one, because it feeds the ICP score.
 */
export const HU_CATEGORY: Record<string, string> = {
  bakery: "Pékség",
  "brunch restaurant": "Brunch étterem",
  cafe: "Kávézó",
  "cake shop": "Cukrászda",
  "coffee shop": "Kávézó",
  consultant: "Tanácsadó",
  electrician: "Villanyszerelő",
  "general contractor": "Generálkivitelező",
  "hair salon": "Fodrászat",
  "ice cream shop": "Fagylaltozó",
  "jewelry store": "Ékszerbolt",
  manufacturer: "Gyártó",
  "pastry shop": "Cukrászda",
  restaurant: "Étterem",
  services: "Szolgáltatás",
  store: "Bolt",
};

/** Null when we have no confident Hungarian name for it — see HU_CATEGORY. */
export function hungarianIndustry(industry: string | null): string | null {
  if (!industry) return null;
  return HU_CATEGORY[industry.trim().toLowerCase()] ?? null;
}

// ---- is this the same business? -------------------------------------------

export interface PlaceCandidate {
  placeId: string | null;
  name: string;
  address: string | null;
  city: string | null;
  category: string | null;
  phone: string | null;
  websiteUri: string | null;
}

export type MatchLevel = "confirmed" | "likely" | "unsure";

/** House number, if the address carries one: "Váci u. 1", "Eszék u. 7b". */
function houseNumber(address: string | null): string | null {
  const hit = fold(address ?? "").match(/\b(\d+[a-z]?(?:\/[a-z0-9]+)?)\b/);
  return hit ? hit[1]! : null;
}

/** The street name, without its type word or its number. */
function street(address: string | null): string | null {
  for (const raw of (address ?? "").split(",")) {
    const folded = fold(raw.trim());
    if (!STREET_WORD.test(folded)) continue;
    const words = folded
      .replace(/[.\d]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STREET_WORD.test(w));
    if (words.length) return words.join(" ");
  }
  return null;
}

/** Distinctive words of a business name — the ones worth comparing. */
function nameTokens(name: string): Set<string> {
  const STOP = new Set([
    "kft", "bt", "zrt", "nyrt", "ev", "es", "and", "the", "hu", "en",
    "budapest", "debrecen", "szeged", "pecs", "gyor", "miskolc",
  ]);
  return new Set(
    fold(name)
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Share of the smaller name's distinctive words that the other one also has. */
export function nameOverlap(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * Same business, or a neighbour?
 *
 * This is the whole risk of the backfill. A text search for a business that has
 * since closed returns the next-best thing on the same street, and writing its
 * phone number into the CRM means the operator rings a stranger. So the address
 * has to agree before anything is written, and the name is only ever a
 * tie-breaker: it is exactly the field we suspect of having been anglicised.
 *
 * A phone number that matches is decisive on its own — two businesses do not
 * share one.
 */
export function matchPlace(company: BackfillCompany, place: PlaceCandidate): MatchLevel {
  const phone = normalizePhone(company.phone).value;
  const placePhone = normalizePhone(place.phone).value;
  if (phone && placePhone && phone === placePhone) return "confirmed";

  const town = company.city ?? townFromAddress(company.address);
  const placeTown = place.city ?? townFromAddress(place.address);
  const sameTown = !!town && !!placeTown && fold(town) === fold(placeTown);

  const companyStreet = street(company.address);
  const placeStreet = street(place.address);
  const sameStreet = !!companyStreet && !!placeStreet && companyStreet === placeStreet;

  const companyNumber = houseNumber(company.address);
  const placeNumber = houseNumber(place.address);
  const sameNumber = !!companyNumber && !!placeNumber && companyNumber === placeNumber;

  const overlap = nameOverlap(company.name, place.name);

  if (sameTown && sameStreet && sameNumber && overlap >= 0.3) return "confirmed";
  if (sameTown && sameStreet && overlap >= 0.6) return "confirmed";
  if (sameTown && sameStreet) return "likely";
  if (sameTown && overlap >= 0.6) return "likely";
  return "unsure";
}

/** The stored spelling of a number, or null when it cannot be read as one. */
function canonicalPhone(raw: string | null): string | null {
  return normalizePhone(raw).value;
}

// ---- what would change ----------------------------------------------------

/** Every field the backfill is allowed to touch. Nothing else is writable. */
export const BACKFILL_FIELDS = [
  "name",
  "city",
  "industry",
  "phone",
  "address",
  "domain",
  "website",
  "googlePlaceId",
  "leadPhone",
  "leadEmail",
] as const;

export type BackfillField = (typeof BACKFILL_FIELDS)[number];

export interface BackfillChange {
  field: BackfillField;
  from: string | null;
  to: string;
  /** A change that REPLACES an existing value, rather than filling a hole. */
  overwrites: boolean;
}

export interface BackfillPlan {
  companyId: string;
  /** Current name, so the operator can recognise the row in the preview. */
  label: string;
  source: "google" | "derived";
  level: MatchLevel;
  changes: BackfillChange[];
}

function change(
  changes: BackfillChange[],
  field: BackfillField,
  from: string | null,
  to: string | null | undefined,
  { replace = false }: { replace?: boolean } = {},
): void {
  const value = (to ?? "").trim();
  if (!value) return;
  const current = (from ?? "").trim();
  if (current === value) return;
  // Filling a hole is always safe; replacing is only offered where the caller
  // asked for it, because most fields may have been edited by hand since.
  if (current && !replace) return;
  changes.push({ field, from: from ?? null, to: value, overwrites: !!current });
}

/**
 * What a confirmed Google match would write.
 *
 * Holes are filled from Google. The two fields that are REPLACED — name and
 * industry — are the anglicised ones this backfill exists for, and both are
 * shown as overwrites in the preview so the operator can leave them alone.
 */
export function planFromPlace(
  company: BackfillCompany,
  place: PlaceCandidate,
  level: MatchLevel,
): BackfillPlan {
  const changes: BackfillChange[] = [];
  change(changes, "googlePlaceId", null, place.placeId);
  change(changes, "name", company.name, place.name, { replace: true });
  // Google's own Hungarian category when it gave one, the closed map when it did
  // not: a paid lookup must never come back with LESS than the free pass.
  change(changes, "industry", company.industry, place.category ?? hungarianIndustry(company.industry), {
    replace: true,
  });
  change(
    changes,
    "city",
    company.city,
    place.city ?? townFromAddress(place.address) ?? townFromAddress(company.address),
  );
  change(changes, "address", company.address, place.address);

  const phone = normalizePhone(place.phone).value ?? place.phone;
  if (company.phone) {
    // A number is already on file. Google's may be a different one — a reception
    // desk, a franchise line — and this is not the place to decide that, so the
    // only thing offered is the stored number in the canonical spelling.
    change(changes, "phone", company.phone, canonicalPhone(company.phone), { replace: true });
  } else {
    change(changes, "phone", null, phone);
  }
  // The number belongs on the lead as well — that is where the operator looks
  // for it, and 10 of these leads are missing one the company row already has.
  // In the canonical spelling, always: a lead carrying Google's "06 1 234 5678"
  // and a company carrying "+3612345678" are two strings for one number, and
  // the duplicate check compares them as two numbers.
  change(changes, "leadPhone", company.leadPhone, canonicalPhone(company.phone ?? phone));

  const domain = normalizeDomain(place.websiteUri);
  change(changes, "domain", company.domain, domain);
  change(changes, "website", company.website, place.websiteUri);

  return { companyId: company.id, label: company.name, source: "google", level, changes };
}

/**
 * What can be repaired without asking anybody: the town out of the address, the
 * industry out of the closed category map, and the phone number the company row
 * already has onto the lead.
 */
export function planFromLocalData(company: BackfillCompany): BackfillPlan {
  const changes: BackfillChange[] = [];
  change(changes, "city", company.city, townFromAddress(company.address));
  change(changes, "industry", company.industry, hungarianIndustry(company.industry), {
    replace: true,
  });
  /**
   * The same number, spelled the way the rest of the system spells it.
   *
   * These rows were written before the Prospector normalised on the way in, so
   * they hold Google's "06 1 234 5678" while every later write produces
   * "+3612345678" — and the duplicate check compares them as two businesses.
   * Only ever a re-spelling: `normalizePhone` returns null rather than a guess
   * when it cannot read the number, and then nothing is proposed.
   */
  change(changes, "phone", company.phone, canonicalPhone(company.phone), { replace: true });
  change(changes, "leadPhone", company.leadPhone, canonicalPhone(company.phone));
  return {
    companyId: company.id,
    label: company.name,
    source: "derived",
    level: "confirmed",
    changes,
  };
}

/** The text search that finds one company again: its name, where it stands. */
export function lookupQuery(company: BackfillCompany): { keyword: string; location: string } {
  const where = company.address ?? company.city ?? "Magyarország";
  return { keyword: company.name, location: where };
}
