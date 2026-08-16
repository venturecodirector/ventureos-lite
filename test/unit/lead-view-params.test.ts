import { describe, it, expect } from "vitest";
import {
  parseFilterSet,
  serializeFilterSet,
  parseSort,
  serializeSort,
  parseColumns,
  serializeColumns,
  filterSetSchema,
  describeCondition,
} from "../../src/modules/leads/view-params";
import { DEFAULT_SORT, EMPTY_FILTER_SET, type FilterSet } from "../../src/modules/leads/filters";
import { DEFAULT_COLUMNS, COLUMN_KEYS } from "../../src/modules/leads/columns";

/**
 * The filter set travels in the URL (so a filtered table is linkable and
 * survives a refresh) and into a saved_views JSON column. Both are places a
 * hand-edited or stale value can arrive from, so parsing is total: it always
 * returns something the engine can evaluate, never throws at a page render.
 */

const SET: FilterSet = {
  match: "all",
  conditions: [
    { field: "stage", operator: "is_any_of", values: ["RESEARCHED", "CONTACTED"] },
    { field: "icpScore", operator: "between", min: 3, max: 5 },
  ],
};

describe("filter set round-trip", () => {
  it("survives serialize → parse unchanged", () => {
    expect(parseFilterSet(serializeFilterSet(SET))).toEqual(SET);
  });

  it("serializes to nothing when there is nothing to filter by", () => {
    // An empty `f=` in the URL of every unfiltered table is noise.
    expect(serializeFilterSet(EMPTY_FILTER_SET)).toBeUndefined();
  });

  it("reads an absent parameter as the empty set", () => {
    expect(parseFilterSet(undefined)).toEqual(EMPTY_FILTER_SET);
    expect(parseFilterSet("")).toEqual(EMPTY_FILTER_SET);
  });
});

describe("filter set parsing is total", () => {
  it("falls back to the empty set on malformed JSON rather than throwing", () => {
    expect(parseFilterSet("{not json")).toEqual(EMPTY_FILTER_SET);
  });

  it("drops a condition naming an unknown field", () => {
    const raw = JSON.stringify({
      match: "all",
      conditions: [
        { field: "stage", operator: "is", value: "RESEARCHED" },
        { field: "salary", operator: "is", value: "big" },
      ],
    });
    expect(parseFilterSet(raw).conditions).toEqual([
      { field: "stage", operator: "is", value: "RESEARCHED" },
    ]);
  });

  it("drops a condition whose operator does not belong to its field", () => {
    // "stage is between 3 and 5" is not a question. Letting it through would
    // have the engine silently answer TRUE for every row.
    const raw = JSON.stringify({
      match: "all",
      conditions: [{ field: "stage", operator: "between", min: 3, max: 5 }],
    });
    expect(parseFilterSet(raw).conditions).toEqual([]);
  });

  it("defaults an unknown match mode to all", () => {
    const raw = JSON.stringify({ match: "sometimes", conditions: [] });
    expect(parseFilterSet(raw).match).toBe("all");
  });

  it("refuses an absurd number of conditions", () => {
    const conditions = Array.from({ length: 100 }, () => ({
      field: "stage",
      operator: "is",
      value: "RESEARCHED",
    }));
    const parsed = parseFilterSet(JSON.stringify({ match: "all", conditions }));
    expect(parsed.conditions.length).toBeLessThanOrEqual(25);
  });

  it("accepts a set that came back from the database as a parsed object", () => {
    // saved_views.filters is JSONB — Prisma hands it back already parsed.
    expect(parseFilterSet(SET as unknown as Record<string, unknown>)).toEqual(SET);
  });
});

describe("filter set validation schema", () => {
  it("accepts a well-formed set", () => {
    expect(filterSetSchema.safeParse(SET).success).toBe(true);
  });

  it("rejects a condition list that is not an array", () => {
    expect(filterSetSchema.safeParse({ match: "all", conditions: "everything" }).success).toBe(false);
  });
});

describe("sort parsing", () => {
  it("round-trips", () => {
    expect(parseSort(serializeSort({ field: "icpScore", direction: "asc" }))).toEqual({
      field: "icpScore",
      direction: "asc",
    });
  });

  it("falls back to the default on an unknown field", () => {
    expect(parseSort("salary:asc")).toEqual(DEFAULT_SORT);
    expect(parseSort(undefined)).toEqual(DEFAULT_SORT);
    expect(parseSort("garbage")).toEqual(DEFAULT_SORT);
  });

  it("falls back to descending on an unknown direction", () => {
    expect(parseSort("icpScore:sideways")).toEqual({ field: "icpScore", direction: "desc" });
  });
});

describe("column parsing", () => {
  it("round-trips a chosen set", () => {
    const chosen = ["contact", "stage", "icpScore"] as const;
    expect(parseColumns(serializeColumns([...chosen]))).toEqual([...chosen]);
  });

  it("falls back to the default set when absent", () => {
    expect(parseColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(parseColumns("")).toEqual(DEFAULT_COLUMNS);
  });

  it("drops unknown column keys", () => {
    expect(parseColumns("contact,salary,stage")).toEqual(["contact", "stage"]);
  });

  it("keeps the contact column even if a stale view omits it", () => {
    // Every row needs something clickable that identifies it. A saved view from
    // before a column was renamed must not render an unusable table.
    expect(parseColumns("stage,icpScore")).toContain("contact");
  });

  it("falls back to the default set when nothing recognisable survives", () => {
    expect(parseColumns("salary,bonus")).toEqual(DEFAULT_COLUMNS);
  });

  it("de-duplicates repeated keys", () => {
    expect(parseColumns("contact,stage,stage")).toEqual(["contact", "stage"]);
  });

  it("only offers columns the table can actually render", () => {
    for (const key of DEFAULT_COLUMNS) expect(COLUMN_KEYS).toContain(key);
  });
});

describe("condition descriptions (what the chips above the table say)", () => {
  it("names the field, the operator and the value", () => {
    const text = describeCondition({ field: "icpScore", operator: "between", min: 3, max: 5 });
    expect(text).toContain("ICP score");
    expect(text).toContain("3");
    expect(text).toContain("5");
  });

  it("reads a list of values without JSON punctuation", () => {
    const text = describeCondition({
      field: "stage",
      operator: "is_any_of",
      values: ["RESEARCHED", "CONTACTED"],
    });
    expect(text).not.toContain("[");
    expect(text).toContain("researched");
  });

  it("says nothing about a value for an operator that has none", () => {
    expect(describeCondition({ field: "owner", operator: "is_not_set" })).toBe("Owner is not set");
  });
});
