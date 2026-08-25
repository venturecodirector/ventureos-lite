import { describe, it, expect } from "vitest";
import {
  townFromAddress,
  hungarianIndustry,
  HU_CATEGORY,
  nameOverlap,
  matchPlace,
  planFromPlace,
  planFromLocalData,
  lookupQuery,
  type BackfillCompany,
  type PlaceCandidate,
} from "@/modules/prospector/backfill";

/**
 * The addresses are the real shapes out of the production table — the whole
 * point of the free half of this backfill is that they parse.
 */
const company = (over: Partial<BackfillCompany> = {}): BackfillCompany => ({
  id: "c1",
  name: "Nosztalgia ékszerbolt",
  address: "Budapest, Erzsébet krt. 15, 1073 Hungary",
  city: null,
  industry: "Jewelry Store",
  phone: "+36 1 322 1234",
  domain: null,
  website: null,
  leadPhone: null,
  leadEmail: null,
  ...over,
});

const place = (over: Partial<PlaceCandidate> = {}): PlaceCandidate => ({
  placeId: "ChIJabc",
  name: "Nosztalgia Ékszerbolt",
  address: "Budapest, Erzsébet krt. 15, 1073 Magyarország",
  city: "Budapest",
  category: "Ékszerbolt",
  phone: "06 1 322 1234",
  websiteUri: null,
  ...over,
});

describe("the town, out of the address we already have", () => {
  it("reads the town from Google's Hungarian format", () => {
    expect(townFromAddress("Budapest, Wesselényi utca 25, 1077 Hungary")).toBe("Budapest");
    expect(townFromAddress("Budapest, Böszörményi út 18b, 1126 Hungary")).toBe("Budapest");
    expect(townFromAddress("Budapest, Knézits u. 8, 1092 Hungary")).toBe("Budapest");
  });

  it("reads it when the postal code leads instead of trails", () => {
    expect(townFromAddress("4025 Debrecen, Piac u. 20, Hungary")).toBe("Debrecen");
    expect(townFromAddress("Piac u. 20, 4025 Debrecen, Hungary")).toBe("Debrecen");
  });

  /**
   * "Harminckettesek tere" is a square and stands where the street segment
   * normally does — taking the first non-country segment would file it as the
   * town.
   */
  it("does not mistake a square or a street for a town", () => {
    expect(townFromAddress("Budapest, Harminckettesek tere, 1086 Hungary")).toBe("Budapest");
    expect(townFromAddress("Erzsébet krt. 15, Hungary")).toBeNull();
    expect(townFromAddress("Bartók Béla út 68, Hungary")).toBeNull();
  });

  /** The floor marker that put "Fszt" in a City field once already. */
  it("refuses a floor marker", () => {
    expect(townFromAddress("Fszt, Hungary")).toBeNull();
    expect(townFromAddress("Fszt, Debrecen, Hungary")).toBe("Debrecen");
  });

  it("has nothing to say about an empty address", () => {
    expect(townFromAddress(null)).toBeNull();
    expect(townFromAddress("")).toBeNull();
    expect(townFromAddress("Hungary")).toBeNull();
  });
});

describe("the industry, out of a closed set", () => {
  it("translates every English category present in the data", () => {
    // The exact list production holds, so a gap here is a gap in the backfill.
    const inProduction = [
      "Bakery", "Manufacturer", "Hair Salon", "Jewelry Store", "General Contractor",
      "Consultant", "Cafe", "Electrician", "Brunch Restaurant", "Services",
      "Pastry Shop", "Coffee Shop", "Ice Cream Shop", "Cake Shop", "Restaurant", "Store",
    ];
    for (const english of inProduction) {
      expect(hungarianIndustry(english), english).toBeTruthy();
    }
    expect(hungarianIndustry("Bakery")).toBe("Pékség");
    expect(hungarianIndustry("Cafe")).toBe("Kávézó");
  });

  it("leaves an unknown category alone rather than guessing", () => {
    expect(hungarianIndustry("Quantum Blacksmith")).toBeNull();
    expect(hungarianIndustry(null)).toBeNull();
    // Already Hungarian — a new prospect — is not in the map and stays put.
    expect(hungarianIndustry("Pékség")).toBeNull();
  });

  it("keeps the map keys lowercase so lookups cannot miss", () => {
    for (const key of Object.keys(HU_CATEGORY)) expect(key).toBe(key.toLowerCase());
  });
});

describe("same business, or a neighbour?", () => {
  it("confirms on a matching phone number alone", () => {
    // Google's spelling and ours differ; the number is the same number.
    expect(matchPlace(company({ address: null }), place({ address: null, city: null }))).toBe(
      "confirmed",
    );
  });

  it("confirms on town, street and house number together", () => {
    const c = company({ phone: null });
    expect(matchPlace(c, place({ phone: null }))).toBe("confirmed");
  });

  /**
   * THE FAILURE THIS GUARDS. The business closed; the search returns the shop
   * two doors down. Writing its phone number into the CRM means the operator
   * rings a stranger.
   */
  it("refuses a different business on the same street", () => {
    const c = company({ phone: null });
    const neighbour = place({
      name: "Aranykapu Zálogház",
      address: "Budapest, Erzsébet krt. 41, 1073 Magyarország",
      phone: "+36 1 999 0000",
    });
    expect(matchPlace(c, neighbour)).toBe("likely");
    expect(matchPlace(c, neighbour)).not.toBe("confirmed");
  });

  it("refuses another town entirely", () => {
    const c = company({ phone: null });
    expect(
      matchPlace(
        c,
        place({ address: "Debrecen, Erzsébet krt. 15, 4025 Magyarország", city: "Debrecen", phone: null }),
      ),
    ).toBe("unsure");
  });

  it("sees through the anglicised name it is here to repair", () => {
    const c = company({
      name: "Mathe Dentistry",
      address: "Debrecen, Piac u. 20, 4025 Hungary",
      phone: null,
      industry: "Dentist",
    });
    const found = place({
      name: "Máthé Fogászat Debrecen",
      address: "Debrecen, Piac u. 20, 4025 Magyarország",
      city: "Debrecen",
      category: "Fogorvos",
      phone: null,
    });
    expect(matchPlace(c, found)).toBe("confirmed");
  });

  it("scores name overlap across accents and legal suffixes", () => {
    expect(nameOverlap("Máthé Fogászat", "Mathe Fogaszat")).toBe(1);
    expect(nameOverlap("Kolozsi Ékszerész Kft.", "Kolozsi Ékszerész")).toBe(1);
    expect(nameOverlap("Nosztalgia ékszerbolt", "Aranykapu Zálogház")).toBe(0);
  });
});

describe("what would change", () => {
  it("fills holes and replaces only the two anglicised fields", () => {
    const plan = planFromPlace(company(), place(), "confirmed");
    const byField = Object.fromEntries(plan.changes.map((c) => [c.field, c]));

    expect(byField.city!.to).toBe("Budapest");
    expect(byField.city!.overwrites).toBe(false);
    expect(byField.googlePlaceId!.to).toBe("ChIJabc");
    expect(byField.industry!.to).toBe("Ékszerbolt");
    expect(byField.industry!.overwrites).toBe(true);
    expect(byField.name!.to).toBe("Nosztalgia Ékszerbolt");
    expect(byField.name!.overwrites).toBe(true);
  });

  it("never proposes a change that changes nothing", () => {
    const settled = company({
      name: "Nosztalgia Ékszerbolt",
      city: "Budapest",
      industry: "Ékszerbolt",
      address: "Budapest, Erzsébet krt. 15, 1073 Magyarország",
      phone: "+3613221234",
      leadPhone: "+3613221234",
    });
    const plan = planFromPlace(settled, place({ placeId: null }), "confirmed");
    expect(plan.changes.map((c) => c.field)).toEqual([]);
  });

  /**
   * Google's number for a place is not always the business's own — a reception
   * desk, a franchise line. Whatever is on file stays on file.
   */
  it("does not swap a phone somebody typed in for Google's", () => {
    const edited = company({ phone: "+36301112222" });
    const plan = planFromPlace(edited, place({ phone: "+36 1 555 0000" }), "confirmed");
    expect(plan.changes.find((c) => c.field === "phone")).toBeUndefined();
  });

  it("puts the phone the company already has onto the lead, canonically spelled", () => {
    const plan = planFromLocalData(company({ city: "Budapest", industry: "Ékszerbolt" }));
    expect(plan.changes).toEqual([
      // The company row keeps Google's spelling; both end up canonical.
      { field: "phone", from: "+36 1 322 1234", to: "+3613221234", overwrites: true },
      { field: "leadPhone", from: null, to: "+3613221234", overwrites: false },
    ]);
  });

  /** Google's national spelling, which is what these rows actually hold. */
  it("re-spells a stored number without changing which number it is", () => {
    const plan = planFromLocalData(
      company({ city: "Budapest", industry: "Ékszerbolt", phone: "06 1 322 1234" }),
    );
    const phone = plan.changes.find((c) => c.field === "phone");
    expect(phone).toEqual({ field: "phone", from: "06 1 322 1234", to: "+3613221234", overwrites: true });
  });

  it("proposes nothing for a number it cannot read", () => {
    const plan = planFromLocalData(
      company({ city: "Budapest", industry: "Ékszerbolt", phone: "hívjon minket" }),
    );
    expect(plan.changes).toEqual([]);
  });

  it("repairs city and industry with no API at all", () => {
    const plan = planFromLocalData(company());
    const byField = Object.fromEntries(plan.changes.map((c) => [c.field, c]));
    expect(byField.city!.to).toBe("Budapest");
    expect(byField.industry!.to).toBe("Ékszerbolt");
    expect(plan.source).toBe("derived");
  });

  /**
   * A paid lookup that returns less than the free pass would is money spent to
   * lose data — this pins the superset.
   */
  it("a Google plan covers everything the free pass would have found", () => {
    const c = company({ phone: null });
    // Google answers, but with no category and no town of its own.
    const thin = place({ category: null, city: null, address: null, phone: "+36 1 322 1234" });
    const google = Object.fromEntries(
      planFromPlace(c, thin, "confirmed").changes.map((x) => [x.field, x.to]),
    );
    const local = planFromLocalData(c);
    for (const change of local.changes) {
      expect(google[change.field], change.field).toBe(change.to);
    }
    expect(google.city).toBe("Budapest");
    expect(google.industry).toBe("Ékszerbolt");
  });

  it("offers Google's number only when there is none on file", () => {
    const empty = planFromPlace(company({ phone: null }), place({ phone: "+36 1 555 0000" }), "confirmed");
    expect(empty.changes.find((c) => c.field === "phone")!.to).toBe("+3615550000");

    const held = planFromPlace(company({ phone: "06 30 111 2222" }), place({ phone: "+36 1 555 0000" }), "confirmed");
    // The stored number, re-spelled — never swapped for Google's.
    expect(held.changes.find((c) => c.field === "phone")!.to).toBe("+36301112222");
  });

  it("asks Google for the business by name and address", () => {
    expect(lookupQuery(company())).toEqual({
      keyword: "Nosztalgia ékszerbolt",
      location: "Budapest, Erzsébet krt. 15, 1073 Hungary",
    });
    expect(lookupQuery(company({ address: null, city: "Szeged" })).location).toBe("Szeged");
  });
});
