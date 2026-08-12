import { describe, it, expect } from "vitest";
import {
  MIN_QUERY_LENGTH,
  MAX_RESULTS,
  normalizeQuery,
  isSearchable,
  taxIdCore,
  taxIdDigits,
  rankMatch,
  bestRank,
  orderHits,
  type SearchHit,
} from "../../src/modules/search/query";

const hit = (over: Partial<SearchHit>): SearchHit => ({
  kind: "lead",
  id: "1",
  title: "t",
  subtitle: "s",
  href: "/x",
  score: 10,
  ...over,
});

describe("query normalisation", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeQuery("  Aventa   Kft.  ")).toBe("Aventa Kft.");
  });

  it("refuses queries too short to be useful", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable(" a ")).toBe(false);
    expect(isSearchable("av")).toBe(true);
  });
});

describe("tax id matching", () => {
  it("reduces every way of typing an adószám to the same 8-digit core", () => {
    // All three forms must find a company stored as "12345678-1-42".
    expect(taxIdCore("12345678")).toBe("12345678");
    expect(taxIdCore("12345678-1-42")).toBe("12345678");
    expect(taxIdCore("12345678142")).toBe("12345678");
    expect(taxIdCore(" 12345678 - 1 - 42 ")).toBe("12345678");
  });

  it("returns null for anything that is not tax-id-shaped", () => {
    expect(taxIdCore("1234567")).toBeNull(); // too short
    expect(taxIdCore("123456789012")).toBeNull(); // too long
    expect(taxIdCore("Aventa")).toBeNull();
    expect(taxIdCore("aventa.hu")).toBeNull();
  });

  it("compares stored ids by digits, ignoring punctuation", () => {
    expect(taxIdDigits("12345678-1-42")).toBe("12345678142");
    expect(taxIdDigits("12345678142").startsWith(taxIdCore("12345678")!)).toBe(true);
  });
});

describe("match ranking", () => {
  it("ranks exact above prefix above word-boundary above mid-word", () => {
    expect(rankMatch("aventa", "aventa")).toBe(100);
    expect(rankMatch("Aventa Logistics", "aventa")).toBe(60);
    expect(rankMatch("Scandinave Aventa", "aventa")).toBe(40);
    expect(rankMatch("Scandinaventa", "aventa")).toBe(20);
  });

  it("is case-insensitive and returns 0 for no match", () => {
    expect(rankMatch("AVENTA", "aventa")).toBe(100);
    expect(rankMatch("Aventa", "zzz")).toBe(0);
    expect(rankMatch(null, "a")).toBe(0);
    expect(rankMatch(undefined, "a")).toBe(0);
  });

  it("takes the best field across a record", () => {
    expect(bestRank([null, "Scandinaventa", "aventa.hu"], "aventa")).toBe(60);
  });
});

describe("result ordering", () => {
  it("sorts by score, then leads before companies before documents", () => {
    const ordered = orderHits([
      hit({ id: "doc", kind: "document", score: 50, title: "Q-1" }),
      hit({ id: "co", kind: "company", score: 50, title: "Co" }),
      hit({ id: "lead", kind: "lead", score: 50, title: "Lead" }),
      hit({ id: "top", kind: "document", score: 90, title: "Q-9" }),
    ]);
    expect(ordered.map((h) => h.id)).toEqual(["top", "lead", "co", "doc"]);
  });

  it("caps the list so the dropdown stays usable", () => {
    const many = Array.from({ length: 40 }, (_, i) => hit({ id: String(i), score: 10 }));
    expect(orderHits(many)).toHaveLength(MAX_RESULTS);
  });

  it("does not mutate its input", () => {
    const input = [hit({ id: "a", score: 1 }), hit({ id: "b", score: 9 })];
    orderHits(input);
    expect(input.map((h) => h.id)).toEqual(["a", "b"]);
  });
});
