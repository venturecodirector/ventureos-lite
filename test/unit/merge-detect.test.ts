import { describe, it, expect } from "vitest";
import {
  defaultChoice,
  findCompanyDuplicates,
  findLeadDuplicates,
  normalizeCompanyName,
  NAME_THRESHOLD,
  type CompanyLike,
  type LeadLike,
} from "../../src/modules/merge/detect";
import { similarity } from "../../src/modules/search/fuzzy";

function company(over: Partial<CompanyLike> & { id: string }): CompanyLike {
  return {
    name: "Danubia Kft",
    domain: null,
    taxId: null,
    createdAt: new Date("2026-01-01"),
    mergedIntoId: null,
    ...over,
  };
}

describe("company name normalisation", () => {
  it("drops the legal form, which carries no identity", () => {
    expect(normalizeCompanyName("Danubia Kft.")).toBe("danubia");
    expect(normalizeCompanyName("DANUBIA ZRT")).toBe("danubia");
  });

  it("folds accents", () => {
    expect(normalizeCompanyName("Kőbányai Sörgyár Zrt.")).toBe("kobanyai sorgyar");
  });

  it("stops two unrelated names scoring on a shared suffix", () => {
    // The point of stripping the form: "alfa" vs "beta" is nothing alike, even
    // though "Alfa Kft" and "Beta Kft" share two thirds of their characters.
    expect(similarity(normalizeCompanyName("Alfa Kft"), normalizeCompanyName("Beta Kft"))).toBeLessThan(
      NAME_THRESHOLD,
    );
  });
});

describe("company duplicates", () => {
  it("calls a shared tax id certain", () => {
    const found = findCompanyDuplicates([
      company({ id: "a", taxId: "12345678-1-42" }),
      company({ id: "b", name: "Totally Different Kft", taxId: "12345678142" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("tax_id");
    expect(found[0].confidence).toBe(100);
  });

  it("calls a shared domain strong but not certain", () => {
    const found = findCompanyDuplicates([
      company({ id: "a", domain: "danubia.hu" }),
      company({ id: "b", name: "Other Kft", domain: "https://www.danubia.hu/" }),
    ]);
    expect(found[0].reason).toBe("domain");
    expect(found[0].confidence).toBeLessThan(100);
  });

  it("reports a pair once, under its strongest reason", () => {
    const found = findCompanyDuplicates([
      company({ id: "a", taxId: "12345678142", domain: "danubia.hu" }),
      company({ id: "b", taxId: "12345678142", domain: "danubia.hu" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("tax_id");
  });

  it("puts the older record first, as the survivor default", () => {
    const found = findCompanyDuplicates([
      company({ id: "new", taxId: "1", createdAt: new Date("2026-06-01") }),
      company({ id: "old", taxId: "1", createdAt: new Date("2025-01-01") }),
    ]);
    expect(found[0].aId).toBe("old");
    expect(found[0].bId).toBe("new");
  });

  it("finds a near-identical name", () => {
    const found = findCompanyDuplicates([
      company({ id: "a", name: "Danubia Kft" }),
      company({ id: "b", name: "Danúbia Kft." }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("name");
  });

  it("ignores a tombstone — it is the resolution of a duplicate, not one", () => {
    const found = findCompanyDuplicates([
      company({ id: "a", taxId: "1" }),
      company({ id: "b", taxId: "1", mergedIntoId: "a" }),
    ]);
    expect(found).toEqual([]);
  });

  it("says nothing about two genuinely different companies", () => {
    expect(
      findCompanyDuplicates([
        company({ id: "a", name: "Alfa Kft", domain: "alfa.hu", taxId: "1" }),
        company({ id: "b", name: "Beta Bt", domain: "beta.hu", taxId: "2" }),
      ]),
    ).toEqual([]);
  });
});

describe("lead duplicates", () => {
  function lead(over: Partial<LeadLike> & { id: string }): LeadLike {
    return {
      contactName: "Kovács Anna",
      email: null,
      companyId: "c1",
      createdAt: new Date("2026-01-01"),
      mergedIntoId: null,
      ...over,
    };
  }

  it("treats an identical email as near-certain", () => {
    const found = findLeadDuplicates([
      lead({ id: "a", email: "anna@danubia.hu" }),
      lead({ id: "b", contactName: "A. Kovács", email: "ANNA@danubia.hu" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBeGreaterThan(90);
  });

  it("only suggests a name match at the SAME company", () => {
    expect(
      findLeadDuplicates([
        lead({ id: "a", contactName: "Kovács Anna", companyId: "c1" }),
        lead({ id: "b", contactName: "Kovacs Anna", companyId: "c2" }),
      ]),
    ).toEqual([]);

    expect(
      findLeadDuplicates([
        lead({ id: "a", contactName: "Kovács Anna", companyId: "c1" }),
        lead({ id: "b", contactName: "Kovacs Anna", companyId: "c1" }),
      ]),
    ).toHaveLength(1);
  });

  it("does not flag two different people at one company", () => {
    expect(
      findLeadDuplicates([
        lead({ id: "a", contactName: "Kovács Anna" }),
        lead({ id: "b", contactName: "Szabó Péter" }),
      ]),
    ).toEqual([]);
  });
});

describe("field defaults", () => {
  it("prefers a value over an absence, whichever side it is on", () => {
    expect(defaultChoice("x", null, { loserIsNewer: true })).toBe("survivor");
    expect(defaultChoice(null, "y", { loserIsNewer: false })).toBe("loser");
    expect(defaultChoice("", "y", { loserIsNewer: false })).toBe("loser");
  });

  it("prefers the newer record when both have a value", () => {
    expect(defaultChoice("old", "new", { loserIsNewer: true })).toBe("loser");
    expect(defaultChoice("new", "old", { loserIsNewer: false })).toBe("survivor");
  });
});
