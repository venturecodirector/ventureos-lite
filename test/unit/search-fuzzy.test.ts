import { describe, it, expect } from "vitest";
import {
  foldText,
  boundedLevenshtein,
  editBudget,
  scoreField,
  scoreFields,
  taxIdMatches,
  SCORE,
} from "@/modules/search/fuzzy";

/**
 * playbook-v2 P3/1 — matching and ranking.
 *
 * The accent cases are the ones that pay for this module: they are what a
 * Hungarian user actually hits, and neither `contains` nor pg_trgm alone fixes
 * them.
 */
describe("foldText", () => {
  it("strips Hungarian accents", () => {
    expect(foldText("Kőbányai")).toBe("kobanyai");
    expect(foldText("Árvíztűrő tükörfúrógép")).toBe("arvizturo tukorfurogep");
    expect(foldText("Nagy Örs")).toBe("nagy ors");
  });

  it("lower-cases and trims", () => {
    expect(foldText("  DANUBIA  ")).toBe("danubia");
  });

  it("survives null and empty input", () => {
    expect(foldText(null)).toBe("");
    expect(foldText(undefined)).toBe("");
  });
});

describe("accent-insensitive search is the point", () => {
  it("finds an accented name from an unaccented query", () => {
    expect(scoreField("Kobanyai", "Kőbányai Kft")).toBeGreaterThan(0);
    expect(scoreField("kobanyai", "Kőbányai Kft")).toBeGreaterThanOrEqual(SCORE.prefix);
  });

  it("works in the other direction too", () => {
    expect(scoreField("Kőbányai", "Kobanyai Kft")).toBeGreaterThan(0);
  });

  it("matches a mid-word accent", () => {
    expect(scoreField("arvizturo", "Árvíztűrő Zrt")).toBeGreaterThan(0);
  });
});

describe("boundedLevenshtein", () => {
  it("counts edits", () => {
    expect(boundedLevenshtein("danubia", "danubia", 3)).toBe(0);
    expect(boundedLevenshtein("kft", "kfz", 3)).toBe(1);
  });

  it("charges ONE for a transposition, not two", () => {
    // The most common way people mistype a name. Plain Levenshtein says 2,
    // which puts it outside the budget a 7-character query gets — so
    // "danubai" would fail to find "danubia", the exact case this exists for.
    expect(boundedLevenshtein("danubia", "danubai", 3)).toBe(1);
    expect(boundedLevenshtein("nagy", "ngay", 3)).toBe(1);
  });

  it("abandons past the budget instead of computing a useless number", () => {
    // The exact value beyond the budget is not information; only "too far" is.
    expect(boundedLevenshtein("alpha", "omega-industries", 2)).toBeGreaterThan(2);
  });

  it("handles empty strings", () => {
    expect(boundedLevenshtein("", "abc", 5)).toBe(3);
    expect(boundedLevenshtein("abc", "", 5)).toBe(3);
  });
});

describe("editBudget", () => {
  it("forgives nothing on a one- or two-letter query", () => {
    // "ab" is one edit from a dozen unrelated words.
    expect(editBudget(1)).toBe(0);
    expect(editBudget(2)).toBe(0);
  });

  it("forgives one edit from three characters up", () => {
    // Hungarian surnames are short and mistyped constantly — "Nagi" for
    // "Nagy" is the most common case there is.
    expect(editBudget(3)).toBe(1);
    expect(editBudget(4)).toBe(1);
    expect(editBudget(7)).toBe(1);
  });

  it("grows with query length", () => {
    expect(editBudget(10)).toBe(2);
    expect(editBudget(20)).toBe(3);
  });
});

describe("ranking tiers", () => {
  it("puts exact above prefix above word-prefix above substring above fuzzy", () => {
    const exact = scoreField("danubia", "Danubia");
    const prefix = scoreField("danu", "Danubia Kft");
    const wordPrefix = scoreField("kft", "Danubia Kft");
    const substring = scoreField("nub", "Danubia Kft");
    const fuzzy = scoreField("danubai", "Danubia Kft");

    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordPrefix);
    expect(wordPrefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });

  it("never lets a fuzzy hit outrank an exact one", () => {
    // The failure this prevents: typing the start of a name you know and having
    // it displaced by a coincidental near-match elsewhere.
    const fuzzyBest = SCORE.fuzzy;
    expect(fuzzyBest).toBeLessThan(SCORE.substring);
    expect(fuzzyBest).toBeLessThan(SCORE.prefix);
  });

  it("prefers a prefix of a short field over a long one", () => {
    const short = scoreField("dan", "Danubia");
    const long = scoreField("dan", "Dan's Very Long Holding Company Kft");
    expect(short).toBeGreaterThan(long);
  });

  it("finds a typo in a surname within a full name", () => {
    expect(scoreField("Nagi Anna", "Nagy Anna")).toBeGreaterThan(0);
    expect(scoreField("annna", "Nagy Anna")).toBeGreaterThan(0);
  });

  it("returns 0 for something genuinely unrelated", () => {
    expect(scoreField("fogászat", "Danubia Kft")).toBe(0);
    expect(scoreField("xy", "Danubia Kft")).toBe(0);
  });

  it("returns 0 for empty input on either side", () => {
    expect(scoreField("", "Danubia")).toBe(0);
    expect(scoreField("danubia", null)).toBe(0);
  });
});

describe("scoreFields", () => {
  it("takes the best field, so a hit anywhere counts", () => {
    const score = scoreFields("anna@", ["Nagy Anna", "anna@nagyceg.hu", null]);
    expect(score).toBeGreaterThanOrEqual(SCORE.prefix);
  });

  it("is 0 when no field matches", () => {
    expect(scoreFields("zzz", ["Nagy Anna", "anna@nagyceg.hu"])).toBe(0);
  });
});

describe("taxIdMatches", () => {
  it("ignores punctuation in either form", () => {
    expect(taxIdMatches("12345678", "12345678-1-42")).toBe(true);
    expect(taxIdMatches("12345678-1-42", "12345678142")).toBe(true);
    expect(taxIdMatches("12345678 1 42", "12345678-1-42")).toBe(true);
  });

  it("matches a partial id from the start", () => {
    expect(taxIdMatches("123456", "12345678-1-42")).toBe(true);
  });

  it("needs enough digits to mean anything", () => {
    expect(taxIdMatches("12", "12345678-1-42")).toBe(false);
  });

  it("does not match a different id", () => {
    expect(taxIdMatches("99999999", "12345678-1-42")).toBe(false);
  });
});

describe("multi-word queries narrow rather than fail", () => {
  it("finds a name whose words are not adjacent in the field", () => {
    // Treating the query as one string scores zero here, which is how a
    // perfectly reasonable search silently returns nothing.
    expect(scoreFields("Nagy Fogászat", ["Nagy Béla Fogászat Kft"])).toBeGreaterThan(0);
  });

  it("requires every term, so a second word narrows the search", () => {
    expect(scoreFields("Nagy Fogászat", ["Nagy Béla Kft"])).toBe(0);
  });

  it("still tolerates accents and typos per term", () => {
    expect(scoreFields("Nagi Fogaszat", ["Nagy Béla Fogászat Kft"])).toBeGreaterThan(0);
  });

  it("matches terms across different fields", () => {
    expect(
      scoreFields("anna nagyceg", ["Nagy Anna", "anna@nagyceg.hu"]),
    ).toBeGreaterThan(0);
  });
});
