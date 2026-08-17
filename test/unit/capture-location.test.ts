import { describe, it, expect } from "vitest";
import { isKnownCity, isKnownCountry, looksLikePersonName, parseLocation, placeKey, stripRegionQualifiers, looksLikePlace } from "../../src/modules/capture/location";

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
    ["anna@example.test", "contains_digits_or_at_sign"],
  ])("refuses %s with reason %s", (input, reason) => {
    expect(parseLocation(input)).toEqual({ ok: false, reason });
  });

  /**
   * A DELIBERATE POLICY CHANGE (capture item 3).
   *
   * "Nowhereville, Freedonia" used to be refused as
   * `tail_is_not_a_country_or_region`, because the rule was "a location must
   * RESOLVE against a known place". That rule is correct about people and wrong
   * about geography: the gazetteer is one Hungarian list plus ~90 international
   * cities, so it refused most of the world. "San Francisco Bay Area" was
   * discarded as `unknown_place` and the operator got a blank City field for a
   * location plainly visible on the profile.
   *
   * An unknown place that is SHAPED like a place is now accepted at MEDIUM
   * confidence and labelled `not_in_gazetteer`. What still protects the field is
   * unchanged and is the part that actually mattered: the person-name pattern, the
   * credential-tail test, and the caller's list of every other person on the page.
   */
  it("accepts an unknown place at medium confidence instead of refusing it", () => {
    const r = parseLocation("Nowhereville, Freedonia");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.city).toBe("Nowhereville");
    expect(r.confidence).toBe("medium");
    expect(r.reason).toBe("not_in_gazetteer");
  });

  it("still refuses an unrecognised head that reads as a PERSON, real country or not", () => {
    // "Some Person, Hungary" — a real country tail cannot launder a human's name
    // into the city field. The head is checked against the person-name pattern
    // separately, because that pattern only applies to a comma-free string.
    const r = parseLocation("Some Person, Hungary");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("does_not_read_as_a_place");
  });

  it("refuses a line too long to be a place", () => {
    expect(parseLocation("a".repeat(200)).ok).toBe(false);
  });

  it("gives every rejection a machine-readable reason code", () => {
    for (const bad of ["Keletso Thophego, CFP", "Hungary", "", "Some Person, Hungary"]) {
      const r = parseLocation(bad);
      expect(r.ok, bad).toBe(false);
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

/**
 * Region qualifiers, and the permissive path (capture item 3).
 *
 * "San Francisco Bay Area" resolved to `unknown_place`, so a location the operator
 * could plainly see on the profile was discarded and the City field left blank
 * with nothing to explain it. Two causes: the gazetteer is Hungarian-focused, and
 * a metro qualifier was never stripped before the lookup.
 */
describe("region qualifiers come off before the gazetteer is asked", () => {
  it("strips the metro wrappers, in both languages", () => {
    const cases: [string, string][] = [
      ["San Francisco Bay Area", "San Francisco"],
      ["Greater Budapest Metropolitan Area", "Budapest"],
      ["Miskolc és környéke", "Miskolc"],
      ["Debrecen vonzáskörzete", "Debrecen"],
      ["Greater London Area", "London"],
      ["Austin Metropolitan Region", "Austin"],
      // Nothing to strip.
      ["Budapest, Hungary", "Budapest, Hungary"],
    ];
    for (const [raw, expected] of cases) {
      expect(stripRegionQualifiers(raw).value, raw).toBe(expected);
    }
  });

  it("reports which qualifier it removed", () => {
    expect(stripRegionQualifiers("San Francisco Bay Area").stripped).toContain("bay area");
    const both = stripRegionQualifiers("Greater Budapest Metropolitan Area").stripped;
    expect(both).toContain("greater");
    expect(both).toContain("metropolitan area");
  });

  /** THE SPECIFIED TABLE. */
  it("resolves every specified location", () => {
    const table: { raw: string; city: string; confidence: "high" | "medium" }[] = [
      { raw: "San Francisco Bay Area", city: "San Francisco", confidence: "high" },
      { raw: "Greater Budapest Metropolitan Area", city: "Budapest", confidence: "high" },
      { raw: "Budapest, Hungary", city: "Budapest", confidence: "high" },
      { raw: "Miskolc és környéke", city: "Miskolc", confidence: "high" },
      { raw: "London, England, United Kingdom", city: "London", confidence: "high" },
    ];
    for (const { raw, city, confidence } of table) {
      const r = parseLocation(raw);
      expect(r.ok, `${raw}: ${r.ok ? "" : r.reason}`).toBe(true);
      if (!r.ok) continue;
      expect(r.city, raw).toBe(city);
      expect(r.confidence, raw).toBe(confidence);
      // The raw string always survives.
      expect(r.full).toBe(raw);
    }
  });

  it("keeps region and country when LinkedIn supplied them", () => {
    const r = parseLocation("London, England, United Kingdom");
    expect(r.ok && r.region).toBe("England");
    expect(r.ok && r.country).toBe("United Kingdom");
  });
});

describe("a place the gazetteer does not know", () => {
  it("is accepted at MEDIUM confidence, labelled, rather than dropped", () => {
    // A real town that no short international list would carry.
    const r = parseLocation("Ouagadougou, Burkina Faso");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.city).toBe("Ouagadougou");
    expect(r.confidence).toBe("medium");
    expect(r.reason).toMatch(/not_in_gazetteer/);
  });

  it("records that a qualifier was stripped in the reason", () => {
    const r = parseLocation("Ouagadougou Metropolitan Area");
    expect(r.ok && r.confidence).toBe("medium");
    expect(r.ok && r.reason).toBe("not_in_gazetteer_after_stripping_qualifier");
  });

  /** The permissive path must not become a way in for a person's name. */
  it("still refuses a person's name and a credential tail", () => {
    for (const raw of ["Keletso Thophego, CFP", "Anna Nagy, MBA", "Dana Whitfield"]) {
      expect(parseLocation(raw).ok, raw).toBe(false);
    }
  });

  it("still refuses anybody on the page, via the blocklist", () => {
    const r = parseLocation("Northbeam Springs", { blocklist: ["Northbeam Springs"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("matches_another_person_on_page");
  });

  it("still refuses something that does not read as a place at all", () => {
    for (const raw of ["we are hiring right now for three roles", "?????", "a"]) {
      expect(parseLocation(raw).ok, raw).toBe(false);
    }
  });

  it("still refuses a country with no city", () => {
    const r = parseLocation("Hungary");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("country_only_no_city");
  });
});
