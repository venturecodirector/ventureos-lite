import { describe, it, expect } from "vitest";
import { classifyWebsite } from "../../src/modules/prospector/website";
import {
  estimateProspectCostUsd,
  TEXT_SEARCH_COST_USD,
  PLACE_DETAILS_COST_USD,
} from "../../src/modules/prospector/cost";
import { searchCacheKey, isCacheFresh } from "../../src/modules/prospector/cache";
import {
  normalizePhone,
  findProspectDuplicate,
} from "../../src/modules/prospector/dedupe";

describe("classifyWebsite (presence flags)", () => {
  it("flags no website", () => {
    expect(classifyWebsite(null)).toBe("none");
    expect(classifyWebsite("")).toBe("none");
  });
  it("flags facebook-only (any facebook host)", () => {
    expect(classifyWebsite("https://facebook.com/aquafix")).toBe("facebook");
    expect(classifyWebsite("https://www.facebook.com/x")).toBe("facebook");
    expect(classifyWebsite("https://m.facebook.com/x")).toBe("facebook");
    expect(classifyWebsite("https://fb.com/x")).toBe("facebook");
  });
  it("flags a real website", () => {
    expect(classifyWebsite("https://budaivizszereles.hu")).toBe("has");
    expect(classifyWebsite("http://www.example.com/contact")).toBe("has");
  });
});

describe("estimateProspectCostUsd (pre-run estimate)", () => {
  it("prices one Text Search page for up to 20 results", () => {
    expect(estimateProspectCostUsd({ expectedResults: 20 })).toBeCloseTo(
      TEXT_SEARCH_COST_USD,
      10,
    );
  });
  it("adds a page per 20 results", () => {
    expect(estimateProspectCostUsd({ expectedResults: 25 })).toBeCloseTo(
      2 * TEXT_SEARCH_COST_USD,
      10,
    );
  });
  it("adds per-row details cost when requested", () => {
    expect(
      estimateProspectCostUsd({ expectedResults: 20, withDetails: true }),
    ).toBeCloseTo(TEXT_SEARCH_COST_USD + 20 * PLACE_DETAILS_COST_USD, 10);
  });
});

describe("searchCacheKey + isCacheFresh (30-day cache)", () => {
  it("normalizes case/whitespace to one key", () => {
    expect(searchCacheKey("  Plumber ", "Budapest", "15 km")).toBe(
      searchCacheKey("plumber", "budapest", "15 km"),
    );
  });
  it("distinguishes different queries", () => {
    expect(searchCacheKey("plumber", "Budapest")).not.toBe(
      searchCacheKey("dentist", "Budapest"),
    );
  });
  it("is fresh within 30 days, stale after", () => {
    const now = new Date("2026-08-31T00:00:00Z");
    expect(isCacheFresh(new Date("2026-08-10T00:00:00Z"), now)).toBe(true);
    expect(isCacheFresh(new Date("2026-07-01T00:00:00Z"), now)).toBe(false);
  });
});

describe("prospect dedupe (Add as lead)", () => {
  it("normalizes phones to digits", () => {
    expect(normalizePhone("+36 30 123 4567")).toBe("36301234567");
    expect(normalizePhone("")).toBeNull();
  });
  it("matches an existing company by domain or phone", () => {
    const existing = [
      { id: "A", domain: "x.com", phone: "36301234567" },
      { id: "B", domain: null, phone: "36209999999" },
    ];
    expect(findProspectDuplicate({ domain: "https://x.com/" }, existing)?.id).toBe("A");
    expect(findProspectDuplicate({ phone: "+36 20 999 9999" }, existing)?.id).toBe("B");
    expect(findProspectDuplicate({ domain: "z.com", phone: "36000000000" }, existing)).toBeNull();
  });
});
