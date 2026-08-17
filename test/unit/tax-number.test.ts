import { describe, it, expect } from "vitest";
import {
  cdvCheckDigit,
  courtMatchesCounty,
  findTaxNumbers,
  TAX_NUMBER_REJECTION_TEXT,
  validateRegNumber,
  validateTaxNumber,
} from "../../src/modules/registry/tax-number";
import {
  nameSimilarity,
  NAME_MATCH_THRESHOLD,
  normalizeCompanyName,
} from "../../src/modules/registry/company-name";

/**
 * The deterministic gate every tax-number candidate passes before anything
 * downstream is allowed to believe it.
 *
 * The governing rule is that a stated confidence buys nothing. A search result
 * that returns a fabricated number "with high confidence" fails the check digit
 * and is discarded, and that is the single most valuable property in this file.
 *
 * The real numbers used below were verified against EU VIES while researching
 * the integration (see docs/integrations/nav-taxpayer.md).
 */

/** NAV's own: 15789934-2-51. Verified valid in VIES. */
const NAV = "15789934-2-51";
/** Magyar Telekom: 10773381-2-44. Verified valid in VIES. */
const TELEKOM = "10773381-2-44";

describe("the check digit", () => {
  it("agrees with real Hungarian tax numbers", () => {
    expect(cdvCheckDigit("1578993")).toBe(4);
    expect(cdvCheckDigit("1077338")).toBe(1);
  });

  it("accepts the two numbers verified against VIES", () => {
    expect(validateTaxNumber(NAV).ok).toBe(true);
    expect(validateTaxNumber(TELEKOM).ok).toBe(true);
  });

  it("REJECTS a fabricated number regardless of any claimed confidence", () => {
    // THE point of this module. A model that returns this "confidently", or a
    // registry that claims it, gets the same answer.
    expect(validateTaxNumber("12862208-2-42")).toEqual({
      ok: false,
      reason: "checksum_failed",
    });
    expect(validateTaxNumber("13763011-1-13")).toEqual({
      ok: false,
      reason: "checksum_failed",
    });
  });

  it("catches a single transposed digit, which is the common human error", () => {
    // 15789934 -> 15798934: two digits swapped, still eight digits.
    expect(validateTaxNumber("15798934").ok).toBe(false);
  });
});

describe("parsing and canonicalising", () => {
  it("splits the three parts and names the county", () => {
    const v = validateTaxNumber(TELEKOM);
    expect(v.ok && v.parts).toMatchObject({
      base: "10773381",
      vatCode: "2",
      countyCode: "44",
      formatted: "10773381-2-44",
      county: "Budapest",
    });
  });

  it("accepts the forms people actually paste", () => {
    for (const form of [
      "10773381-2-44",
      "10773381244",
      " 10773381 / 2 / 44 ",
      "10773381–2–44", // en dashes, from a PDF
      "10773381",
    ]) {
      expect(validateTaxNumber(form).ok, form).toBe(true);
    }
  });

  it("keeps a bare törzsszám as such rather than inventing the rest", () => {
    const v = validateTaxNumber("10773381");
    expect(v.ok && v.parts.formatted).toBe("10773381");
    expect(v.ok && v.parts.vatCode).toBeNull();
    expect(v.ok && v.parts.county).toBeNull();
  });
});

describe("the VAT code and county code gates", () => {
  it.each([["1"], ["2"], ["3"], ["4"], ["5"]])("accepts VAT code %s", (code) => {
    expect(validateTaxNumber(`15789934-${code}-51`).ok).toBe(true);
  });

  it.each([["0"], ["6"], ["9"]])("rejects VAT code %s", (code) => {
    expect(validateTaxNumber(`15789934-${code}-51`)).toEqual({
      ok: false,
      reason: "vat_code_invalid",
    });
  });

  it("accepts every documented county code, including the Budapest and special ones", () => {
    for (const cc of ["02", "20", "22", "40", "41", "42", "43", "44", "51"]) {
      expect(validateTaxNumber(`15789934-2-${cc}`).ok, cc).toBe(true);
    }
  });

  it("rejects codes that are not authorities", () => {
    for (const cc of ["00", "01", "21", "45", "50", "99"]) {
      expect(validateTaxNumber(`15789934-2-${cc}`).ok, cc).toBe(false);
    }
  });

  it("gives every rejection a reason with user-facing text", () => {
    for (const bad of ["", "123", "abcdefgh", "12862208-2-42", "15789934-9-51", "15789934-2-99"]) {
      const v = validateTaxNumber(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(TAX_NUMBER_REJECTION_TEXT[v.reason]).toBeTruthy();
    }
  });
});

describe("extracting tax numbers from an impresszum page's text", () => {
  it("finds the valid one and silently drops the invalid one", () => {
    const text = `
      Danubia Fogászat Kft.
      Székhely: 1054 Budapest, Széchenyi utca 2.
      Adószám: 10773381-2-44
      Cégjegyzékszám: 01-09-041928
      (korábbi, hibás adat: 12862208-2-42)
    `;
    const found = findTaxNumbers(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.formatted).toBe("10773381-2-44");
  });

  it("handles the unseparated eleven-digit form", () => {
    expect(findTaxNumbers("adoszam 10773381244 vege")[0]!.formatted).toBe("10773381-2-44");
  });

  it("does not report the same company twice from two spellings", () => {
    const found = findTaxNumbers("10773381-2-44 és ugyanaz: 10773381244");
    expect(found).toHaveLength(1);
  });

  it("returns nothing from a page with no tax number", () => {
    expect(findTaxNumbers("Kapcsolat: info@example.hu, telefon: 06 1 234 5678")).toEqual([]);
  });
});

describe("registration number (cégjegyzékszám) — unverified by design", () => {
  it("accepts the documented format and names the court", () => {
    expect(validateRegNumber("01-09-041928")).toMatchObject({
      ok: true,
      formatted: "01-09-041928",
      court: "Budapest",
    });
  });

  it.each([["1-09-041928"], ["01-9-041928"], ["01-09-4192"], ["01/09/041928"], [""]])(
    "rejects malformed %s",
    (v) => {
      expect(validateRegNumber(v).ok).toBe(false);
    },
  );

  it("rejects an unknown court code", () => {
    expect(validateRegNumber("99-09-041928").reason).toBe("unknown_court_code");
  });

  it("warns when the court disagrees with the NAV-returned seat's county", () => {
    // The only consistency check available without a registry subscription: a
    // company seated in Budapest cannot be registered at the Zala county court.
    expect(courtMatchesCounty("01-09-041928", "Budapest")).toMatchObject({
      checked: true,
      agrees: true,
    });
    expect(courtMatchesCounty("20-09-041928", "Budapest")).toMatchObject({
      checked: true,
      agrees: false,
      court: "Zala",
    });
  });

  it("does not claim to have checked when it could not", () => {
    // No registration number, or no seat, means no verdict — not a pass.
    expect(courtMatchesCounty(null, "Budapest").checked).toBe(false);
    expect(courtMatchesCounty("01-09-041928", null).checked).toBe(false);
  });

  it("compares counties accent-insensitively", () => {
    expect(courtMatchesCounty("06-09-041928", "Csongrád-Csanád").agrees).toBe(true);
  });
});

describe("normalising a LinkedIn company name", () => {
  it("handles the observed tagline case", () => {
    // Captured verbatim from a real profile, quotation marks included.
    const n = normalizeCompanyName("'Seyu - Together for victory!'");
    expect(n.primary).toBe("Seyu");
    expect(n.hadTagline).toBe(true);
    expect(n.candidates[0]).toBe("Seyu");
    // The full string stays as a later candidate, in case the dash was part of
    // the actual name.
    expect(n.candidates).toContain("Seyu - Together for victory!");
  });

  it("detects the legal form and offers the name with and without it", () => {
    const n = normalizeCompanyName("Danubia Fogászat Kft.");
    expect(n.legalForm).toBe("Kft.");
    expect(n.primary).toBe("Danubia Fogászat");
    expect(n.candidates).toEqual(["Danubia Fogászat Kft.", "Danubia Fogászat"]);
  });

  it("does not mistake a dash inside a real name for a tagline", () => {
    // "Danubia - Fogászat Kft." is one name: the legal form is after the dash,
    // so the split was wrong and the whole string is the name.
    const n = normalizeCompanyName("Danubia - Fogászat Kft.");
    expect(n.primary).toBe("Danubia Fogászat");
    expect(n.legalForm).toBe("Kft.");
  });

  it("recognises the longer legal forms before their suffixes", () => {
    expect(normalizeCompanyName("Zöld Jövő Nonprofit Kft.").legalForm).toBe("Nonprofit Kft.");
    expect(normalizeCompanyName("Példa Korlátolt Felelősségű Társaság").legalForm).toBe(
      "Korlátolt Felelősségű Társaság",
    );
  });

  it("adds city-qualified variants last, since a wrong city is worse than none", () => {
    const n = normalizeCompanyName("Alföld Présüzem Zrt.", "Kecskemét");
    expect(n.candidates[0]).toBe("Alföld Présüzem Zrt.");
    expect(n.candidates.at(-1)).toContain("Kecskemét");
  });

  it("returns nothing to search for when there is no name", () => {
    expect(normalizeCompanyName("").candidates).toEqual([]);
    expect(normalizeCompanyName(null).candidates).toEqual([]);
  });
});

describe("cross-checking the NAV legal name against what we searched for", () => {
  it("scores a captured trading name against its full legal name as a match", () => {
    // A wrong tax number can be well-formed, registered, and belong to a real
    // but DIFFERENT company. This is the only defence against attaching it.
    expect(
      nameSimilarity("Danubia Fogászat", "DANUBIA FOGÁSZAT KORLÁTOLT FELELŐSSÉGŰ TÁRSASÁG"),
    ).toBeGreaterThanOrEqual(NAME_MATCH_THRESHOLD);
    expect(nameSimilarity("Seyu", "SEYU KFT.")).toBeGreaterThanOrEqual(NAME_MATCH_THRESHOLD);
  });

  it("scores an unrelated company below the threshold, forcing confirmation", () => {
    expect(nameSimilarity("Seyu", "MAGYAR TELEKOM NYRT.")).toBeLessThan(NAME_MATCH_THRESHOLD);
    expect(nameSimilarity("Danubia Fogászat", "ALFÖLD PRÉSÜZEM ZRT.")).toBeLessThan(
      NAME_MATCH_THRESHOLD,
    );
  });

  it("ignores legal-form words, which carry no identifying information", () => {
    // Two unrelated Kft.s share "kft" and nothing else; that must not score.
    expect(nameSimilarity("Alpha Kft.", "Beta Kft.")).toBe(0);
  });

  it("is accent-insensitive, so an unaccented source still matches", () => {
    expect(nameSimilarity("Alfold Presuzem", "ALFÖLD PRÉSÜZEM ZRT.")).toBeGreaterThanOrEqual(
      NAME_MATCH_THRESHOLD,
    );
  });

  it("returns zero rather than throwing on empty input", () => {
    expect(nameSimilarity(null, "Anything Kft.")).toBe(0);
    expect(nameSimilarity("Anything", "")).toBe(0);
  });
});
