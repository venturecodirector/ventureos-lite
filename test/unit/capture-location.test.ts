import { describe, it, expect } from "vitest";
import {
  isKnownCity,
  isKnownCountry,
  looksLikePersonName,
  parseLocation,
  placeKey,
} from "../../src/modules/capture/location";

/**
 * The city field, and the rule that governs it: EMPTY BEATS WRONG.
 *
 * "Keletso Thophego, CFP" — a stranger from a profile's right-hand rail — was
 * stored as a lead's city. The old test for "is this a place" was "contains a
 * comma, no digits, under 100 characters", which a person with a credential
 * suffix passes on all three counts. So the test is now positive: a location has
 * to RESOLVE against a known place, not merely fail to look like something else.
 */
describe("the two values that actually went wrong", () => {
  it("refuses a person with a credential suffix", () => {
    expect(parseLocation("Keletso Thophego, CFP")).toEqual({
      ok: false,
      reason: "reads_as_a_person_name",
    });
  });

  it("refuses a bare person name", () => {
    expect(parseLocation("Cristina Amor Maclang").ok).toBe(false);
  });

  it("refuses a section heading", () => {
    expect(parseLocation("People you may know").ok).toBe(false);
  });
});

describe("the shapes LinkedIn actually emits", () => {
  it("splits City, Region, Country", () => {
    expect(parseLocation("Budapest, Budapest, Hungary")).toMatchObject({
      ok: true,
      city: "Budapest",
      region: "Budapest",
      country: "Hungary",
    });
  });

  it("splits an accented Hungarian line with a county", () => {
    expect(parseLocation("Kecskemét, Bács-Kiskun, Magyarország")).toMatchObject({
      ok: true,
      city: "Kecskemét",
      region: "Bács-Kiskun",
      country: "Magyarország",
    });
  });

  it("splits City, Country", () => {
    expect(parseLocation("Vienna, Austria")).toMatchObject({
      ok: true,
      city: "Vienna",
      country: "Austria",
      region: null,
    });
  });

  it("accepts a bare known city", () => {
    expect(parseLocation("Budapest")).toMatchObject({ ok: true, city: "Budapest" });
  });

  it("handles a US state abbreviation as the region", () => {
    expect(parseLocation("New York, NY, United States")).toMatchObject({
      ok: true,
      city: "New York",
      region: "NY",
      country: "United States",
    });
  });

  it("keeps the full string alongside the parts", () => {
    const parsed = parseLocation("Budapest, Budapest, Hungary");
    expect(parsed.ok && parsed.full).toBe("Budapest, Budapest, Hungary");
  });
});

describe("what it refuses, and why", () => {
  it.each([
    ["", "no_location_text"],
    ["Hungary", "country_only_no_city"],
    ["Nowhereville, Freedonia", "tail_is_not_a_country_or_region"],
    ["anna@example.test", "contains_digits_or_at_sign"],
  ])("refuses %s with reason %s", (input, reason) => {
    expect(parseLocation(input)).toEqual({ ok: false, reason });
  });

  it("refuses an unrecognised head even when the country is real", () => {
    // A stranger's name with a real-looking tail must not become a city.
    expect(parseLocation("Some Person, Hungary")).toEqual({
      ok: false,
      reason: "head_is_not_a_known_city",
    });
  });

  it("refuses a line too long to be a place", () => {
    expect(parseLocation("a".repeat(200)).ok).toBe(false);
  });

  it("gives every rejection a machine-readable reason code", () => {
    for (const bad of ["Keletso Thophego, CFP", "Hungary", "", "Nowhereville, Freedonia"]) {
      const r = parseLocation(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("person-name detection", () => {
  it.each([
    "Keletso Thophego, CFP",
    "Anna Nagy, MBA",
    "John Smith, PhD",
    "Cristina Amor Maclang",
    "Kovács Anna",
  ])("reads %s as a person", (v) => {
    expect(looksLikePersonName(v)).toBe(true);
  });

  it.each(["Budapest", "New York", "Novi Sad", "Budapest, Hungary", "Kecskemét, Bács-Kiskun, Magyarország"])(
    "does not read %s as a person",
    (v) => {
      expect(looksLikePersonName(v)).toBe(false);
    },
  );
});

describe("the gazetteer", () => {
  it("knows Hungarian cities with their accents", () => {
    for (const c of ["Budapest", "Kecskemét", "Győr", "Pécs", "Székesfehérvár", "Nyíregyháza"]) {
      expect(isKnownCity(c), c).toBe(true);
    }
  });

  it("matches accent-insensitively, so an unaccented spelling still resolves", () => {
    expect(isKnownCity("kecskemet")).toBe(true);
    expect(isKnownCity("GYOR")).toBe(true);
  });

  it("knows country names in English and Hungarian", () => {
    expect(isKnownCountry("Hungary")).toBe(true);
    expect(isKnownCountry("Magyarország")).toBe(true);
    expect(isKnownCountry("magyarorszag")).toBe(true);
  });

  it("does not invent places", () => {
    expect(isKnownCity("Nowhereville")).toBe(false);
    expect(isKnownCountry("Freedonia")).toBe(false);
  });

  it("normalizes for comparison without mangling the stored value", () => {
    expect(placeKey("Kecskemét")).toBe("kecskemet");
    const parsed = parseLocation("Kecskemét, Bács-Kiskun, Magyarország");
    // The stored city keeps its accents; only the comparison key drops them.
    expect(parsed.ok && parsed.city).toBe("Kecskemét");
  });
});
