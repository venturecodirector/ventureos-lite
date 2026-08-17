/**
 * Hungarian tax numbers: validating one before anything is allowed to believe it.
 *
 * This is the gate every candidate passes through before it reaches NAV, the UI
 * or a company record. It is deliberately cheap and deliberately first, because
 * the expensive steps downstream — an API call, a person's attention, a contract
 * — are all wasted on a number that was never well-formed.
 *
 * WHAT IT DOES NOT MEAN. A number that passes here is *plausible*, not real.
 * Verified while researching this: 10625790 has a correct check digit and is not
 * a registered taxpayer at all. So the checksum's job is to discard typos and
 * fabrications for free; establishing that a company exists is NAV's job, and
 * the two must never be confused. A search result that "confidently" returns a
 * fabricated number will usually fail here, which is the point.
 *
 * Structure, confirmed against NAV's own number (15789934-2-51):
 *
 *   15789934 - 2 - 51
 *   └──┬───┘   │   └┬┘
 *      │       │    └── territorial tax authority (county) code
 *      │       └─────── VAT code (áfakód), 1-5
 *      └─────────────── törzsszám: 7 significant digits + 1 CDV check digit
 */

/** CDV weights across the first seven digits. From the published algorithm. */
const CDV_WEIGHTS = [9, 7, 3, 1, 9, 7, 3] as const;

/**
 * VAT code — the 9th digit.
 *
 *   1  not in the VAT system / exempt activity
 *   2  general VAT rules
 *   3  simplified (EVA-era) status
 *   4  member of a VAT group
 *   5  a VAT group's common number
 */
const VAT_CODES = new Set(["1", "2", "3", "4", "5"]);

/**
 * County / territorial tax authority code — the last two digits.
 *
 * 02-20 and 22-40 are the county authorities (each county has two codes), then
 * the Budapest and special directorates. Non-resident taxpayers are uniformly
 * 51, which is why a foreign-owned Hungarian entity can carry 51 while being
 * seated anywhere — the code is the authority, not the address.
 */
const COUNTY_CODES = new Set<string>([
  ...Array.from({ length: 19 }, (_, i) => String(i + 2).padStart(2, "0")), // 02-20
  ...Array.from({ length: 19 }, (_, i) => String(i + 22).padStart(2, "0")), // 22-40
  "41", // North Budapest
  "42", // East Budapest
  "43", // South Budapest
  "44", // Priority Taxpayers
  "51", // Priority Cases; also every non-resident taxpayer
]);

/** Which county a code belongs to, for the cégjegyzékszám consistency check. */
const COUNTY_BY_CODE: Record<string, string> = {
  "02": "Baranya", "22": "Baranya",
  "03": "Bács-Kiskun", "23": "Bács-Kiskun",
  "04": "Békés", "24": "Békés",
  "05": "Borsod-Abaúj-Zemplén", "25": "Borsod-Abaúj-Zemplén",
  "06": "Csongrád-Csanád", "26": "Csongrád-Csanád",
  "07": "Fejér", "27": "Fejér",
  "08": "Győr-Moson-Sopron", "28": "Győr-Moson-Sopron",
  "09": "Hajdú-Bihar", "29": "Hajdú-Bihar",
  "10": "Heves", "30": "Heves",
  "11": "Komárom-Esztergom", "31": "Komárom-Esztergom",
  "12": "Nógrád", "32": "Nógrád",
  "13": "Pest", "33": "Pest",
  "14": "Somogy", "34": "Somogy",
  "15": "Szabolcs-Szatmár-Bereg", "35": "Szabolcs-Szatmár-Bereg",
  "16": "Jász-Nagykun-Szolnok", "36": "Jász-Nagykun-Szolnok",
  "17": "Tolna", "37": "Tolna",
  "18": "Vas", "38": "Vas",
  "19": "Veszprém", "39": "Veszprém",
  "20": "Zala", "40": "Zala",
  "41": "Budapest", "42": "Budapest", "43": "Budapest", "44": "Budapest",
  "51": "Kiemelt ügyek",
};

export interface TaxNumberParts {
  /** The 8-digit törzsszám, including its check digit. */
  base: string;
  vatCode: string | null;
  countyCode: string | null;
  /** Canonical display form: 12345678-1-42, or just 12345678 when that is all. */
  formatted: string;
  county: string | null;
}

export type TaxNumberVerdict =
  | { ok: true; parts: TaxNumberParts }
  | { ok: false; reason: TaxNumberRejection };

export type TaxNumberRejection =
  | "empty"
  | "wrong_length"
  | "not_digits"
  | "checksum_failed"
  | "vat_code_invalid"
  | "county_code_invalid";

/** The check digit the first seven digits imply. */
export function cdvCheckDigit(sevenDigits: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += CDV_WEIGHTS[i]! * Number(sevenDigits[i]);
  return (10 - (sum % 10)) % 10;
}

/**
 * Validate and canonicalise a tax number.
 *
 * Accepts `12345678-1-42`, `12345678142`, `12345678`, and the same with spaces
 * or spurious punctuation — people paste these from impresszum pages, invoices
 * and PDFs, and rejecting a real number over a stray character helps nobody.
 * What it will NOT do is accept a number whose check digit is wrong, no matter
 * how confident whatever produced it claimed to be.
 */
export function validateTaxNumber(raw: string | null | undefined): TaxNumberVerdict {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 0) return { ok: false, reason: "empty" };
  if (!/^\d+$/.test(digits)) return { ok: false, reason: "not_digits" };
  if (digits.length !== 8 && digits.length !== 11) {
    return { ok: false, reason: "wrong_length" };
  }

  const base = digits.slice(0, 8);
  if (cdvCheckDigit(base) !== Number(base[7])) {
    // The single most valuable check in this file. It is what makes a fabricated
    // number cheap to detect, and it overrides any stated confidence.
    return { ok: false, reason: "checksum_failed" };
  }

  let vatCode: string | null = null;
  let countyCode: string | null = null;
  if (digits.length === 11) {
    vatCode = digits[8]!;
    countyCode = digits.slice(9, 11);
    if (!VAT_CODES.has(vatCode)) return { ok: false, reason: "vat_code_invalid" };
    if (!COUNTY_CODES.has(countyCode)) return { ok: false, reason: "county_code_invalid" };
  }

  return {
    ok: true,
    parts: {
      base,
      vatCode,
      countyCode,
      formatted: countyCode ? `${base}-${vatCode}-${countyCode}` : base,
      county: countyCode ? (COUNTY_BY_CODE[countyCode] ?? null) : null,
    },
  };
}

/** Human-readable, for the UI. Reason codes are for logs and tests. */
export const TAX_NUMBER_REJECTION_TEXT: Record<TaxNumberRejection, string> = {
  empty: "Nincs megadva adószám.",
  wrong_length: "Az adószám 8 vagy 11 jegyű lehet.",
  not_digits: "Az adószám csak számjegyeket tartalmazhat.",
  checksum_failed: "Az adószám ellenőrző jegye hibás — ez nem létező adószám.",
  vat_code_invalid: "Érvénytelen áfakód (a 9. jegy 1–5 lehet).",
  county_code_invalid: "Érvénytelen megyekód (az utolsó két jegy).",
};

/**
 * Extract every plausible tax number from a block of text.
 *
 * Used on impresszum pages, which is a page written by a human for humans:
 * "Adószám: 12345678-2-42", "adoszam 12345678242", inside a table, inside a
 * footer. Candidates are validated, so the noise this finds costs nothing.
 */
export function findTaxNumbers(text: string): TaxNumberParts[] {
  const found = new Map<string, TaxNumberParts>();
  // 11-digit forms first, so the richer match wins over its own 8-digit prefix.
  const patterns = [
    /\b(\d{8})\s*[-–—/]\s*(\d)\s*[-–—/]\s*(\d{2})\b/g,
    /\b(\d{11})\b/g,
    /\b(\d{8})\b/g,
  ];
  for (const re of patterns) {
    for (const m of (text ?? "").matchAll(re)) {
      const verdict = validateTaxNumber(m[0]);
      if (!verdict.ok) continue;
      // Keep the first (richest) form seen for a given törzsszám.
      if (!found.has(verdict.parts.base)) found.set(verdict.parts.base, verdict.parts);
    }
  }
  return [...found.values()];
}

/**
 * Registration number (cégjegyzékszám): NN-NN-NNNNNN.
 *
 * NAV does not return this, so it stays on the unverified search path — and the
 * one check available without a registry subscription is that the court code
 * agrees with the county the NAV-returned seat implies. A company seated in
 * Budapest cannot be registered at the Zala county court.
 */
const COURT_BY_CODE: Record<string, string> = {
  "01": "Budapest", "02": "Baranya", "03": "Bács-Kiskun", "04": "Békés",
  "05": "Borsod-Abaúj-Zemplén", "06": "Csongrád-Csanád", "07": "Fejér",
  "08": "Győr-Moson-Sopron", "09": "Hajdú-Bihar", "10": "Heves",
  "11": "Komárom-Esztergom", "12": "Nógrád", "13": "Pest", "14": "Somogy",
  "15": "Szabolcs-Szatmár-Bereg", "16": "Jász-Nagykun-Szolnok", "17": "Tolna",
  "18": "Vas", "19": "Veszprém", "20": "Zala",
};

export interface RegNumberVerdict {
  ok: boolean;
  formatted: string | null;
  court: string | null;
  reason: string | null;
}

export function validateRegNumber(raw: string | null | undefined): RegNumberVerdict {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, formatted: null, court: null, reason: "empty" };
  const m = /^(\d{2})\s*[-–—]\s*(\d{2})\s*[-–—]\s*(\d{6})$/.exec(s);
  if (!m) return { ok: false, formatted: null, court: null, reason: "wrong_format" };
  const court = COURT_BY_CODE[m[1]!] ?? null;
  if (!court) return { ok: false, formatted: null, court: null, reason: "unknown_court_code" };
  return { ok: true, formatted: `${m[1]}-${m[2]}-${m[3]}`, court, reason: null };
}

/**
 * Does the registration number's court agree with the county of the seat?
 *
 * A mismatch is a warning, never a rejection: the registration number came from
 * search and the seat came from NAV, so a disagreement means the *search* is
 * probably wrong — but it could also be a company that moved. The user decides;
 * we only make the disagreement visible.
 */
export function courtMatchesCounty(
  regNumber: string | null | undefined,
  seatCounty: string | null | undefined,
): { checked: boolean; agrees: boolean; court: string | null } {
  const reg = validateRegNumber(regNumber);
  if (!reg.ok || !seatCounty) return { checked: false, agrees: true, court: reg.court };
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return { checked: true, agrees: norm(reg.court!) === norm(seatCounty), court: reg.court };
}

export { COUNTY_BY_CODE, COURT_BY_CODE };
