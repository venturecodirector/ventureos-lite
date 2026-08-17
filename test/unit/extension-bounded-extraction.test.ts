import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * Extraction against the committed fixtures.
 *
 * Fixture (a) is the reference case: a real signed-in profile shape with a
 * populated right-hand rail, reconstructed from the diagnostics of the page that
 * actually broke. Run against the previous reader it returns headline "People
 * you may know" and location "Keletso Thophego, CFP" — a section heading and a
 * stranger, filed as a lead's own details. Everything below exists to keep that
 * from being possible rather than merely fixed.
 */
const SOURCE = readFileSync(join(process.cwd(), "extension/content.js"), "utf8");
const FIXTURES = join(process.cwd(), "test/fixtures/linkedin");

interface Field {
  source: string;
  confidence: string;
}
interface Extracted {
  url: string;
  name?: string;
  headline?: string;
  companyName?: string;
  location?: string;
  jobTitle?: string;
  bio?: string;
  photoUrl?: string;
  provenance: Record<string, Field>;
  skipped: Record<string, string>;
  boundary: {
    ok: boolean;
    reason: string | null;
    identitiesInCard: number | null;
    excludedNegativeSpaceNodes: number;
    otherPeopleOnPage: number;
    contactTriggerPresent: boolean;
  };
  _attempts: Record<string, string[]>;
}

function extract(fixture: string, slug: string): Extracted {
  const html = readFileSync(join(FIXTURES, fixture), "utf8");
  const dom = new JSDOM(html, { url: `https://www.linkedin.com/in/${slug}/` });
  const fn = new Function(
    "document",
    "window",
    "location",
    "URL",
    `return (${SOURCE.trim().replace(/;\s*$/, "")})`,
  );
  return fn(dom.window.document, dom.window, dom.window.location, dom.window.URL) as Extracted;
}

/** Mutate a fixture's HTML before parsing, for the deliberately-broken cases. */
function extractMutated(fixture: string, slug: string, mutate: (html: string) => string): Extracted {
  const html = mutate(readFileSync(join(FIXTURES, fixture), "utf8"));
  const dom = new JSDOM(html, { url: `https://www.linkedin.com/in/${slug}/` });
  const fn = new Function(
    "document",
    "window",
    "location",
    "URL",
    `return (${SOURCE.trim().replace(/;\s*$/, "")})`,
  );
  return fn(dom.window.document, dom.window, dom.window.location, dom.window.URL) as Extracted;
}

const OWNER = "anna-kovacs-fixture";

/** The two strangers actually mis-captured on the real page. */
const RAIL_PEOPLE = ["Cristina Amor Maclang", "Keletso Thophego, CFP"];

describe("fixture (a) — the reference case: profile with a populated right rail", () => {
  const out = extract("a-authenticated-with-right-rail.html", OWNER);

  it("establishes a bounded card holding exactly one identity", () => {
    expect(out.boundary.ok).toBe(true);
    expect(out.boundary.identitiesInCard).toBe(1);
    // The rail was found and excluded rather than merely not selected.
    expect(out.boundary.excludedNegativeSpaceNodes).toBeGreaterThan(0);
    expect(out.boundary.otherPeopleOnPage).toBeGreaterThan(0);
  });

  it("reads the profile's own headline, not the rail's section heading", () => {
    expect(out.headline).toBe("Ügyvezető @ Danubia Fogászat | mosolytervezés");
    expect(out.provenance.headline?.source).toBe("topcard");
  });

  it("reads the profile's own location", () => {
    expect(out.location).toBe("Budapest, Budapest, Hungary");
  });

  it("reads name, role and employer", () => {
    expect(out.name).toBe("Kovács Anna");
    expect(out.jobTitle).toBe("Ügyvezető");
    expect(out.companyName).toBe("Danubia Fogászat Kft.");
  });

  it("picks the largest srcset candidate for the photo", () => {
    // 400w beats 200w, and neither is the data: placeholder in src.
    expect(out.photoUrl).toContain("shrink_400_400");
    expect(out.photoUrl).not.toMatch(/^data:/);
  });

  it("finds the contact-info trigger without pressing it", () => {
    expect(out.boundary.contactTriggerPresent).toBe(true);
  });

  /**
   * THE REGRESSION. Not "the values are right" — that a right-rail person's name
   * can never reach these fields at all. Asserted per field against every
   * stranger on the page, so a future refactor that reintroduces the class of
   * bug fails here even if it picks a different stranger.
   */
  it("can never populate headline or city with a right-rail person's name", () => {
    for (const field of ["headline", "location", "name", "companyName", "jobTitle"] as const) {
      const value = out[field];
      if (!value) continue;
      for (const person of RAIL_PEOPLE) {
        expect(value.toLowerCase()).not.toContain(person.toLowerCase());
      }
    }
  });

  it("never reports a negative-space section heading as a field", () => {
    const headings = ["people you may know", "more profiles for you"];
    for (const field of ["headline", "location", "bio", "companyName"] as const) {
      const value = out[field]?.toLowerCase();
      if (!value) continue;
      for (const h of headings) expect(value).not.toContain(h);
    }
  });
});

describe("fixture (b) — the same profile with no right rail", () => {
  const out = extract("b-no-right-rail.html", OWNER);

  it("reads the same fields, so the fix does not depend on a rail existing", () => {
    expect(out.boundary.ok).toBe(true);
    expect(out.headline).toBe("Ügyvezető @ Danubia Fogászat | mosolytervezés");
    expect(out.location).toBe("Budapest, Budapest, Hungary");
    expect(out.name).toBe("Kovács Anna");
  });

  it("excludes nothing, because there is nothing to exclude", () => {
    expect(out.boundary.excludedNegativeSpaceNodes).toBe(0);
    expect(out.boundary.otherPeopleOnPage).toBe(0);
  });
});

describe("fixture (d) — accented name, Hungarian interface and location", () => {
  const out = extract("d-accented-name-hungarian-location.html", "toth-szucs-ors-abel-fixture");

  it("accepts a name whose word order differs from the page title", () => {
    // Title: "Örs Ábel Tóth-Szűcs". Card: "Tóth-Szűcs Örs Ábel". Hungarian puts
    // the family name first; a string comparison would reject a correct name, so
    // the validator compares token SETS.
    expect(out.name).toBe("Tóth-Szűcs Örs Ábel");
    expect(out.skipped.name).toBeUndefined();
  });

  it("reads a headline containing a middot separator", () => {
    // Regression on the containment filter: LinkedIn renders the separator as
    // its own element, so "·" is a line of its own — and "·" is a substring of
    // "Gyártásvezető · Kecskemét", which silently deleted the headline.
    expect(out.headline).toBe("Gyártásvezető · Kecskemét");
  });

  it("reads a three-part Hungarian location", () => {
    expect(out.location).toBe("Kecskemét, Bács-Kiskun, Magyarország");
  });

  it("still reads the Hungarian-labelled sections", () => {
    expect(out.bio).toContain("autóipari gyártásban");
    expect(out.companyName).toBe("Alföld Présüzem Zrt.");
  });
});

describe("fixture (e) — a second identity inside the top card", () => {
  const out = extract("e-mangled-two-identities.html", OWNER);

  it("fails the boundary test loudly rather than reading anyway", () => {
    expect(out.boundary.ok).toBe(false);
    expect(out.boundary.reason).toBe("card_contains_more_than_one_identity");
    expect(out.boundary.identitiesInCard).toBe(2);
  });

  it("degrades to name-only — never widens the scope to compensate", () => {
    expect(out.name).toBe("Kovács Anna");
    expect(out.headline).toBeUndefined();
    expect(out.location).toBeUndefined();
    expect(out.photoUrl).toBeUndefined();
  });

  it("says why the photo was skipped instead of returning a silent null", () => {
    expect(out.skipped.photoUrl).toBe("no_bounded_card");
  });
});

describe("the boundary test cannot be talked out of failing", () => {
  it("fails when a stranger's anchor is injected into a previously-good card", () => {
    // Fixture (a) passes. Inject one extra identity into the owner's own column
    // — not into the rail, which pruning would remove — and it must stop
    // extracting rather than pick between two people.
    // Anchored on the Contact-info link, which is unique and sits inside the
    // owner's own column — injecting before the first `<ul>` would land in the
    // rail, which pruning removes, and would prove nothing.
    const out = extractMutated("a-authenticated-with-right-rail.html", OWNER, (html) => {
      const marker = '<a href="/in/anna-kovacs-fixture/overlay/contact-info/"';
      expect(html).toContain(marker);
      return html.replace(
        marker,
        '<a href="/in/an-intruder-fixture/">Intruder Person</a>' + marker,
      );
    });
    expect(out.boundary.ok).toBe(false);
    expect(out.headline).toBeUndefined();
    expect(out.location).toBeUndefined();
    expect(out.name).toBe("Kovács Anna");
  });

  it("reports no card when the page is not a profile at all", () => {
    const out = extractMutated("b-no-right-rail.html", OWNER, (html) =>
      // Strip every anchor to the owner: nothing identifies whose page this is.
      html.replace(/\/in\/anna-kovacs-fixture\//g, "/feed/"),
    );
    expect(out.boundary.ok).toBe(false);
    expect(out.boundary.reason).toBe("no_anchor_to_this_profile");
    expect(out.headline).toBeUndefined();
  });
});

describe("provenance and reason codes", () => {
  const out = extract("a-authenticated-with-right-rail.html", OWNER);

  it("labels every accepted field with where it came from", () => {
    for (const field of ["name", "headline", "location", "photoUrl"]) {
      expect(out.provenance[field]?.source, `${field} has no source`).toBeTruthy();
      expect(["title", "topcard", "overlay", "derived", "manual"]).toContain(
        out.provenance[field]!.source,
      );
    }
  });

  it("records every strategy attempted, so a failure is explainable", () => {
    expect(out._attempts.name?.length).toBeGreaterThan(0);
    expect(out._attempts.headline?.join(" ")).toContain("accepted");
  });

  it("returns a reason code for each field it declined to fill", () => {
    const declined = extract("e-mangled-two-identities.html", OWNER);
    for (const reason of Object.values(declined.skipped)) {
      expect(reason).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
