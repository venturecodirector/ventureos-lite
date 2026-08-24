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
  it("normalizes phones to one canonical form", () => {
    expect(normalizePhone("+36 30 123 4567")).toBe("+36301234567");
    expect(normalizePhone("")).toBeNull();
  });

  /**
   * The bug this replaced: comparing digits alone. Places hands back the trunk
   * form "06 30 …" while site enrichment writes "+36 30 …" onto the same
   * company, and stripping non-digits made those two spellings of ONE number
   * into "06301234567" and "36301234567" — so the duplicate went in.
   */
  it("sees the trunk form and the international form as one number", () => {
    expect(normalizePhone("06 30 123 4567")).toBe(normalizePhone("+36301234567"));
    const existing = [{ id: "A", domain: null, phone: "+36301234567" }];
    expect(findProspectDuplicate({ phone: "06 30 123 4567" }, existing)?.id).toBe("A");
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

// ---------------------------------------------------------------------------
// What the search actually returns, and what survives into a lead.
// ---------------------------------------------------------------------------

import { mapApiPlace, PLACES_REQUEST_LOCALE, type ApiPlace } from "../../src/lib/places";
import { googleSignals } from "../../src/modules/prospector/signals";

/**
 * The shape of a real Places v1 search result, with an invented business in it.
 * The structure is what matters and is copied from a live response; the values
 * are made up so no real company's details sit in the repo.
 */
const PLACE: ApiPlace = {
  id: "ChIJexampleexampleexample",
  displayName: { text: "Példa Fogászat Debrecen" },
  formattedAddress: "Debrecen, Példa utca 8, 4028 Hungary",
  addressComponents: [
    { longText: "8", shortText: "8", types: ["street_number"] },
    { longText: "Példa utca", shortText: "Példa utca", types: ["route"] },
    { longText: "Debrecen", shortText: "Debrecen", types: ["locality", "political"] },
    { longText: "Hungary", shortText: "HU", types: ["country", "political"] },
    { longText: "4028", shortText: "4028", types: ["postal_code"] },
  ],
  primaryTypeDisplayName: { text: "Fogászat" },
  rating: 4.9,
  userRatingCount: 304,
  nationalPhoneNumber: "06 30 905 2282",
  websiteUri: "https://pelda-fogaszat.hu/",
  businessStatus: "OPERATIONAL",
  googleMapsUri: "https://maps.google.com/?cid=1",
};

describe("mapApiPlace — the fields the Prospector was throwing away", () => {
  it("reads the town out of addressComponents rather than parsing prose", () => {
    expect(mapApiPlace(PLACE).city).toBe("Debrecen");
    expect(mapApiPlace(PLACE).postalCode).toBe("4028");
  });

  it("keeps the place id, the business status and the maps link", () => {
    const r = mapApiPlace(PLACE);
    expect(r.placeId).toBe("ChIJexampleexampleexample");
    expect(r.businessStatus).toBe("OPERATIONAL");
    expect(r.mapsUri).toBe("https://maps.google.com/?cid=1");
  });

  /**
   * A real Debrecen clinic comes back from Google like this: `locality` holds
   * "Fszt" (földszint — the ground floor) and the actual city sits in a
   * component with NO types on it at all. Reading `locality` faithfully wrote
   * "Fszt" into the City field of the lead.
   */
  it("does not file the ground floor as the town", () => {
    const malformed: ApiPlace = {
      ...PLACE,
      formattedAddress: "Fszt, Debrecen, Példa u. 34, 4025",
      addressComponents: [
        { longText: "Debrecen" }, // no types — Google really sends this
        { longText: "34", types: ["street_number"] },
        { longText: "Példa utca", types: ["route"] },
        { longText: "Fszt", types: ["locality", "political"] },
        { longText: "Magyarország", types: ["country", "political"] },
        { longText: "4025", types: ["postal_code"] },
      ],
    };
    expect(mapApiPlace(malformed).city).toBe("Debrecen");
    expect(mapApiPlace(malformed).postalCode).toBe("4025");
  });

  it("rejects the other floor and unit markers too, not just that one", () => {
    for (const junk of ["fszt", "Földszint", "2", "II.", "em", "A/3", "Pf"]) {
      const p: ApiPlace = {
        addressComponents: [
          { longText: junk, types: ["locality"] },
          { longText: "Szeged", types: ["postal_town"] },
        ],
      };
      expect(mapApiPlace(p).city, junk).toBe("Szeged");
    }
  });

  it("falls back through postal_town and the county when there is no locality", () => {
    const noLocality: ApiPlace = {
      ...PLACE,
      addressComponents: [
        { longText: "Hajdú-Bihar", types: ["administrative_area_level_1", "political"] },
        { longText: "Hungary", types: ["country"] },
      ],
    };
    expect(mapApiPlace(noLocality).city).toBe("Hajdú-Bihar");
  });

  it("survives a response with nothing in it", () => {
    const empty = mapApiPlace({});
    expect(empty.name).toBe("Unknown");
    expect(empty.city).toBeNull();
    expect(empty.placeId).toBeNull();
  });
});

describe("the request asks for Hungarian", () => {
  /**
   * Not cosmetic. Without a language the API answers in English and returns a
   * different NAME, not just a translated category: "Máthé Fogászat Debrecen"
   * came back as "Mathe Dentistry", and that anglicised string was written to
   * company.name — from where it flows into quotes, contracts and outreach.
   */
  it("sends languageCode and regionCode", () => {
    expect(PLACES_REQUEST_LOCALE).toEqual({ languageCode: "hu", regionCode: "HU" });
  });
});

describe("googleSignals", () => {
  it("keeps the rating and the review count, which used to stop at the table", () => {
    expect(googleSignals({ rating: 4.9, reviews: 304 })).toEqual(["Google 4.9★ (304 reviews)"]);
    expect(googleSignals({ rating: 5, reviews: null })).toEqual(["Google 5.0★"]);
    expect(googleSignals({ rating: null, reviews: 12 })).toEqual(["Google: 12 reviews"]);
  });

  it("warns when Google says the business is shut", () => {
    expect(googleSignals({ businessStatus: "CLOSED_PERMANENTLY" })).toContain(
      "Permanently closed on Google",
    );
    expect(googleSignals({ businessStatus: "OPERATIONAL" })).toEqual([]);
  });

  it("says nothing when Google knew nothing", () => {
    expect(googleSignals({})).toEqual([]);
  });
});

describe("place id dedupe", () => {
  /**
   * The businesses this tool is FOR are the ones with no website — and often no
   * listed phone either. Of the 71 companies prospected on this installation,
   * one has a domain. Those rows matched nothing and could be added twice.
   */
  it("catches a re-add of a business with neither a website nor a phone", () => {
    const existing = [{ id: "A", domain: null, phone: null, placeId: "ChIJabc" }];
    expect(findProspectDuplicate({ placeId: "ChIJabc" }, existing)?.id).toBe("A");
    expect(findProspectDuplicate({ placeId: "ChIJother" }, existing)).toBeNull();
    // Nothing to go on at all is not a match against a row that has a place id.
    expect(findProspectDuplicate({}, existing)).toBeNull();
  });

  it("still matches when the business has since put up a website", () => {
    const existing = [{ id: "A", domain: null, phone: null, placeId: "ChIJabc" }];
    expect(
      findProspectDuplicate({ placeId: "ChIJabc", domain: "new-site.hu" }, existing)?.id,
    ).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// The radius, which used to reach nothing but the cache key.
// ---------------------------------------------------------------------------

import {
  parseRadiusMeters,
  haversineKm,
  boundingRectangle,
  MAX_RADIUS_M,
  MIN_RADIUS_M,
} from "../../src/lib/geo";

describe("parseRadiusMeters", () => {
  it("reads what a person types into a free-text box", () => {
    expect(parseRadiusMeters("15 km")).toBe(15_000);
    expect(parseRadiusMeters("15km")).toBe(15_000);
    expect(parseRadiusMeters("15")).toBe(15_000); // bare number = km, per the placeholder
    expect(parseRadiusMeters("1.5 km")).toBe(1_500);
    expect(parseRadiusMeters("1,5 km")).toBe(1_500); // Hungarian decimal comma
    expect(parseRadiusMeters("2000 m")).toBe(2_000);
  });

  it("treats an empty or wordless box as no radius, not as zero", () => {
    for (const raw of ["", "   ", "mindegy", null, undefined]) {
      expect(parseRadiusMeters(raw)).toBeNull();
    }
  });

  it("clamps to what Google will accept", () => {
    expect(parseRadiusMeters("500 km")).toBe(MAX_RADIUS_M);
    expect(parseRadiusMeters("1 m")).toBe(MIN_RADIUS_M);
    expect(parseRadiusMeters("0 km")).toBeNull();
  });
});

describe("boundingRectangle + haversineKm", () => {
  const debrecen = { lat: 47.5288879, lng: 21.6254485 };

  it("contains the circle it was built from", () => {
    const r = boundingRectangle(debrecen, 3_000);
    // Due north and due east at exactly 3 km must still be inside the box.
    expect(r.high.latitude).toBeGreaterThan(debrecen.lat);
    expect(r.low.latitude).toBeLessThan(debrecen.lat);
    const northEdge = haversineKm(debrecen, { lat: r.high.latitude, lng: debrecen.lng });
    expect(northEdge).toBeGreaterThanOrEqual(2.99);
    expect(northEdge).toBeLessThan(3.1);
  });

  /**
   * Why the results are then filtered by exact distance: the rectangle's corner
   * is r·√2 from the centre, so "15 km" would otherwise quietly mean "up to
   * 21 km diagonally".
   */
  it("has corners well outside the circle — hence the distance check", () => {
    const r = boundingRectangle(debrecen, 3_000);
    const corner = haversineKm(debrecen, { lat: r.high.latitude, lng: r.high.longitude });
    expect(corner).toBeGreaterThan(4);
  });

  it("does not span the globe near the poles", () => {
    const r = boundingRectangle({ lat: 89.9, lng: 0 }, 50_000);
    expect(r.high.longitude).toBeLessThanOrEqual(180);
    expect(r.low.longitude).toBeGreaterThanOrEqual(-180);
    expect(r.high.latitude).toBeLessThanOrEqual(90);
  });

  it("measures a distance we can check by hand", () => {
    // Budapest → Debrecen is about 190 km.
    const km = haversineKm({ lat: 47.4979, lng: 19.0402 }, debrecen);
    expect(km).toBeGreaterThan(180);
    expect(km).toBeLessThan(200);
    expect(haversineKm(debrecen, debrecen)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Classifying every row, not the first screenful.
// ---------------------------------------------------------------------------

import {
  CLASSIFY_BATCH,
  batchStarts,
  resolveBatchIndices,
} from "../../src/modules/prospector/classify";

describe("classify batching", () => {
  it("covers all 60 rows Google can return, in three calls", () => {
    expect(batchStarts(60)).toEqual([0, 25, 50]);
    expect(batchStarts(25)).toEqual([0]);
    expect(batchStarts(26)).toEqual([0, 25]);
    expect(batchStarts(0)).toEqual([]);
    // The button says "1 Haiku call / 25 rows" — now true rather than aspirational.
    expect(CLASSIFY_BATCH).toBe(25);
  });

  /**
   * Every batch asks the model about rows 0..24, so the offset is the whole
   * job: applying the third batch's answers without it would overwrite the
   * first batch's verdicts — wrong data, where before there was merely missing
   * data.
   */
  it("puts a later batch's answers on the later rows", () => {
    const items = [{ index: 0 }, { index: 24 }];
    expect(resolveBatchIndices(items, 50, 10).map((r) => r.row)).toEqual([50]);
    expect(resolveBatchIndices(items, 25, 25).map((r) => r.row)).toEqual([25, 49]);
    expect(resolveBatchIndices(items, 0, 25).map((r) => r.row)).toEqual([0, 24]);
  });

  it("drops an index the model invented instead of writing it somewhere", () => {
    const junk = [{ index: 40 }, { index: -1 }, { index: 1.5 }, { index: 3 }];
    expect(resolveBatchIndices(junk, 0, 25).map((r) => r.row)).toEqual([3]);
    // A short final batch is bounded by its OWN length, not by the batch size.
    expect(resolveBatchIndices([{ index: 7 }], 50, 5)).toEqual([]);
  });
});
