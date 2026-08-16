import { describe, it, expect } from "vitest";
import {
  applyFilters,
  applySort,
  matchesFilters,
  paginate,
  DEFAULT_PAGE_SIZE,
  type FilterSet,
  type FilterableLead,
} from "../../src/modules/leads/filters";

/**
 * The filter engine (playbook-v2 P3/2). Pure, so every operator is provable
 * without a database — which is the point: this is what "select all matching"
 * runs over before a bulk action touches 200 rows.
 */

const NOW = new Date("2026-08-16T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function lead(over: Partial<FilterableLead> = {}): FilterableLead {
  return {
    id: "l1",
    contactName: "Nagy Anna",
    title: "Ügyvezető",
    email: "anna@danubia.hu",
    phone: "+36 30 111 2222",
    company: "Danubia Kft",
    industry: "Fogászat",
    city: "Budapest",
    icpScore: 4,
    stage: "RESEARCHED",
    signals: ["outdated website", "hiring"],
    source: "PROSPECTOR",
    ownerId: "user-fanni",
    lastActivityAt: daysAgo(3),
    createdAt: daysAgo(30),
    ...over,
  };
}

/** One condition, matched with "all". */
function only(condition: FilterSet["conditions"][number]): FilterSet {
  return { match: "all", conditions: [condition] };
}

describe("filter engine — empty and degenerate sets", () => {
  it("passes everything when there are no conditions", () => {
    expect(matchesFilters(lead(), { match: "all", conditions: [] }, NOW)).toBe(true);
  });

  it("passes everything on an empty ANY set too, rather than nothing", () => {
    // An empty "any" is vacuously false in strict logic, which would render an
    // empty table the moment someone switches the match mode before adding a
    // condition. No filter means no filtering.
    expect(matchesFilters(lead(), { match: "any", conditions: [] }, NOW)).toBe(true);
  });
});

describe("filter engine — stage and source", () => {
  it("matches a single stage with is, and excludes with is_not", () => {
    expect(matchesFilters(lead(), only({ field: "stage", operator: "is", value: "RESEARCHED" }), NOW)).toBe(true);
    expect(matchesFilters(lead(), only({ field: "stage", operator: "is", value: "QUALIFIED" }), NOW)).toBe(false);
    expect(matchesFilters(lead(), only({ field: "stage", operator: "is_not", value: "QUALIFIED" }), NOW)).toBe(true);
  });

  it("matches any of several stages", () => {
    const f = only({ field: "stage", operator: "is_any_of", values: ["QUALIFIED", "RESEARCHED"] });
    expect(matchesFilters(lead(), f, NOW)).toBe(true);
    expect(matchesFilters(lead({ stage: "NOT_NOW" }), f, NOW)).toBe(false);
  });

  it("matches the lead source", () => {
    const f = only({ field: "source", operator: "is_any_of", values: ["PROSPECTOR", "REFERRAL"] });
    expect(matchesFilters(lead(), f, NOW)).toBe(true);
    expect(matchesFilters(lead({ source: "MANUAL" }), f, NOW)).toBe(false);
  });
});

describe("filter engine — ICP score range", () => {
  it("treats between as inclusive at both ends", () => {
    const f = only({ field: "icpScore", operator: "between", min: 3, max: 5 });
    expect(matchesFilters(lead({ icpScore: 3 }), f, NOW)).toBe(true);
    expect(matchesFilters(lead({ icpScore: 5 }), f, NOW)).toBe(true);
    expect(matchesFilters(lead({ icpScore: 2 }), f, NOW)).toBe(false);
  });

  it("excludes an unscored lead from every numeric comparison", () => {
    // An unscored lead is not "score 0" — it is unknown. P1/1d made the same
    // distinction for scoring, and a range filter must not silently invent a
    // zero, or "score below 3" would return every lead nobody has researched.
    for (const f of [
      only({ field: "icpScore", operator: "between", min: 0, max: 2 }),
      only({ field: "icpScore", operator: "lte", value: 2 }),
      only({ field: "icpScore", operator: "gte", value: 0 }),
    ]) {
      expect(matchesFilters(lead({ icpScore: null }), f, NOW)).toBe(false);
    }
  });

  it("finds unscored leads with is_not_set", () => {
    const f = only({ field: "icpScore", operator: "is_not_set" });
    expect(matchesFilters(lead({ icpScore: null }), f, NOW)).toBe(true);
    expect(matchesFilters(lead({ icpScore: 0 }), f, NOW)).toBe(false);
  });
});

describe("filter engine — text matching reuses the P3/1 search rules", () => {
  it("ignores accents, so a query typed without them still matches", () => {
    const f = only({ field: "city", operator: "contains", value: "kobanya" });
    expect(matchesFilters(lead({ city: "Kőbánya" }), f, NOW)).toBe(true);
  });

  it("ignores case", () => {
    const f = only({ field: "industry", operator: "contains", value: "FOGÁSZAT" });
    expect(matchesFilters(lead(), f, NOW)).toBe(true);
  });

  it("forgives a typo on the free-text condition", () => {
    // "matches" runs the P3/1 fuzzy scorer across the lead's searchable fields,
    // so the filter box behaves like the search box rather than like SQL LIKE.
    const f = only({ field: "text", operator: "matches", value: "danubai" });
    expect(matchesFilters(lead(), f, NOW)).toBe(true);
  });

  it("does not match unrelated text", () => {
    const f = only({ field: "text", operator: "matches", value: "zzzzqqqq" });
    expect(matchesFilters(lead(), f, NOW)).toBe(false);
  });

  it("searches across name, company, email, industry and city together", () => {
    for (const q of ["Nagy", "Danubia", "anna@danubia.hu", "Fogászat", "Budapest"]) {
      expect(matchesFilters(lead(), only({ field: "text", operator: "matches", value: q }), NOW)).toBe(true);
    }
  });
});

describe("filter engine — signals", () => {
  it("has_any_of matches when one signal overlaps", () => {
    const f = only({ field: "signals", operator: "has_any_of", values: ["hiring", "funding"] });
    expect(matchesFilters(lead(), f, NOW)).toBe(true);
  });

  it("has_all_of requires every named signal", () => {
    expect(
      matchesFilters(lead(), only({ field: "signals", operator: "has_all_of", values: ["hiring", "outdated website"] }), NOW),
    ).toBe(true);
    expect(
      matchesFilters(lead(), only({ field: "signals", operator: "has_all_of", values: ["hiring", "funding"] }), NOW),
    ).toBe(false);
  });

  it("has_none_of excludes leads carrying any of them", () => {
    const f = only({ field: "signals", operator: "has_none_of", values: ["hiring"] });
    expect(matchesFilters(lead(), f, NOW)).toBe(false);
    expect(matchesFilters(lead({ signals: [] }), f, NOW)).toBe(true);
  });

  it("compares signals accent- and case-insensitively, like the rest of the text rules", () => {
    const f = only({ field: "signals", operator: "has_any_of", values: ["REGI WEBOLDAL"] });
    expect(matchesFilters(lead({ signals: ["régi weboldal"] }), f, NOW)).toBe(true);
  });
});

describe("filter engine — owner", () => {
  it("matches an assigned owner", () => {
    expect(matchesFilters(lead(), only({ field: "owner", operator: "is", value: "user-fanni" }), NOW)).toBe(true);
    expect(matchesFilters(lead(), only({ field: "owner", operator: "is", value: "user-tamas" }), NOW)).toBe(false);
  });

  it("finds unassigned leads", () => {
    const f = only({ field: "owner", operator: "is_not_set" });
    expect(matchesFilters(lead({ ownerId: null }), f, NOW)).toBe(true);
    expect(matchesFilters(lead(), f, NOW)).toBe(false);
  });
});

describe("filter engine — last-activity age", () => {
  it("within_days matches recent activity only", () => {
    const f = only({ field: "lastActivityAge", operator: "within_days", value: 7 });
    expect(matchesFilters(lead({ lastActivityAt: daysAgo(3) }), f, NOW)).toBe(true);
    expect(matchesFilters(lead({ lastActivityAt: daysAgo(30) }), f, NOW)).toBe(false);
  });

  it("older_than_days matches a lead that has gone quiet", () => {
    const f = only({ field: "lastActivityAge", operator: "older_than_days", value: 14 });
    expect(matchesFilters(lead({ lastActivityAt: daysAgo(30) }), f, NOW)).toBe(true);
    expect(matchesFilters(lead({ lastActivityAt: daysAgo(3) }), f, NOW)).toBe(false);
  });

  it("counts a lead nobody ever touched as older than any window, and never as recent", () => {
    // The whole point of an age filter is finding neglected leads. A lead with
    // no activity at all is the most neglected there is, so excluding it from
    // "older than 14 days" would hide exactly what the filter is for.
    const never = lead({ lastActivityAt: null });
    expect(matchesFilters(never, only({ field: "lastActivityAge", operator: "older_than_days", value: 14 }), NOW)).toBe(true);
    expect(matchesFilters(never, only({ field: "lastActivityAge", operator: "within_days", value: 14 }), NOW)).toBe(false);
  });
});

describe("filter engine — has email / has phone", () => {
  it("distinguishes present from absent and from blank", () => {
    const has = only({ field: "hasEmail", operator: "is_true" });
    expect(matchesFilters(lead(), has, NOW)).toBe(true);
    expect(matchesFilters(lead({ email: null }), has, NOW)).toBe(false);
    // A whitespace-only column is absence wearing a costume.
    expect(matchesFilters(lead({ email: "   " }), has, NOW)).toBe(false);
  });

  it("is_false finds the leads missing a phone number", () => {
    const f = only({ field: "hasPhone", operator: "is_false" });
    expect(matchesFilters(lead({ phone: null }), f, NOW)).toBe(true);
    expect(matchesFilters(lead(), f, NOW)).toBe(false);
  });
});

describe("filter engine — combining conditions", () => {
  const conditions: FilterSet["conditions"] = [
    { field: "stage", operator: "is", value: "RESEARCHED" },
    { field: "icpScore", operator: "gte", value: 4 },
  ];

  it("ALL requires every condition", () => {
    expect(matchesFilters(lead(), { match: "all", conditions }, NOW)).toBe(true);
    expect(matchesFilters(lead({ icpScore: 2 }), { match: "all", conditions }, NOW)).toBe(false);
  });

  it("ANY requires only one", () => {
    expect(matchesFilters(lead({ icpScore: 2 }), { match: "any", conditions }, NOW)).toBe(true);
    expect(matchesFilters(lead({ icpScore: 2, stage: "NOT_NOW" }), { match: "any", conditions }, NOW)).toBe(false);
  });

  it("applyFilters keeps only the matching rows", () => {
    const rows = [lead({ id: "a", icpScore: 5 }), lead({ id: "b", icpScore: 1 }), lead({ id: "c", icpScore: 4 })];
    const kept = applyFilters(rows, only({ field: "icpScore", operator: "gte", value: 4 }), NOW);
    expect(kept.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("sorting", () => {
  it("sorts by score in both directions", () => {
    const rows = [lead({ id: "a", icpScore: 2 }), lead({ id: "b", icpScore: 5 }), lead({ id: "c", icpScore: 3 })];
    expect(applySort(rows, { field: "icpScore", direction: "desc" }).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(applySort(rows, { field: "icpScore", direction: "asc" }).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("puts missing values last in BOTH directions", () => {
    // Ascending by score should not open the table with a wall of unscored
    // leads: "no value" is not the smallest value, it is the least interesting.
    const rows = [lead({ id: "a", icpScore: null }), lead({ id: "b", icpScore: 5 }), lead({ id: "c", icpScore: 1 })];
    expect(applySort(rows, { field: "icpScore", direction: "asc" }).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(applySort(rows, { field: "icpScore", direction: "desc" }).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts stages in pipeline order, not alphabetically", () => {
    // Alphabetical would read ACCEPTED, CONTACTED, DISQUALIFIED, … which is not
    // an order anyone thinks in.
    const rows = [lead({ id: "a", stage: "QUALIFIED" }), lead({ id: "b", stage: "RESEARCHED" }), lead({ id: "c", stage: "CONTACTED" })];
    expect(applySort(rows, { field: "stage", direction: "asc" }).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts names in a locale-aware way, so accented letters land where a reader expects", () => {
    const rows = [lead({ id: "a", contactName: "Zoltán" }), lead({ id: "b", contactName: "Ábel" }), lead({ id: "c", contactName: "Béla" })];
    expect(applySort(rows, { field: "contactName", direction: "asc" }).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties on id so paging cannot show or skip the same row twice", () => {
    // Without a total order, two rows with equal scores can swap between page
    // 1 and page 2 and a row silently disappears from the results.
    const rows = [lead({ id: "b", icpScore: 3 }), lead({ id: "a", icpScore: 3 })];
    expect(applySort(rows, { field: "icpScore", direction: "desc" }).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("pagination", () => {
  const rows = Array.from({ length: 125 }, (_, i) => lead({ id: `l${i}` }));

  it("reports the total and the page count", () => {
    const page = paginate(rows, 1, 50);
    expect(page.total).toBe(125);
    expect(page.pageCount).toBe(3);
    expect(page.rows).toHaveLength(50);
  });

  it("returns the remainder on the last page", () => {
    expect(paginate(rows, 3, 50).rows).toHaveLength(25);
  });

  it("clamps a page beyond the end rather than returning nothing", () => {
    // Deleting the last rows of a filtered set while sitting on the last page
    // otherwise leaves the user staring at an empty table.
    const page = paginate(rows, 99, 50);
    expect(page.page).toBe(3);
    expect(page.rows).toHaveLength(25);
  });

  it("clamps a page below one", () => {
    expect(paginate(rows, 0, 50).page).toBe(1);
  });

  it("reports one empty page for an empty result set", () => {
    const page = paginate([], 1, 50);
    expect(page.pageCount).toBe(1);
    expect(page.total).toBe(0);
    expect(page.rows).toEqual([]);
  });

  it("has a sane default page size", () => {
    expect(paginate(rows, 1).rows).toHaveLength(DEFAULT_PAGE_SIZE);
  });
});
