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
