import { describe, it, expect } from "vitest";
import {
  canEditView,
  canSeeView,
  normalizeViewName,
  viewMatchesState,
  viewToQuery,
  type LeadView,
} from "../../src/modules/leads/views";
import { DEFAULT_SORT, type FilterSet } from "../../src/modules/leads/filters";
import { DEFAULT_COLUMNS } from "../../src/modules/leads/columns";

/**
 * Saved views (playbook-v2 P3/2): a named filter set + columns + sort, personal
 * or workspace-shared, rendered as the tabs above the table.
 */

const FILTERS: FilterSet = {
  match: "all",
  conditions: [{ field: "stage", operator: "is", value: "RESEARCHED" }],
};

function view(over: Partial<LeadView> = {}): LeadView {
  return {
    id: "v1",
    name: "Hot leads",
    ownerId: "fanni",
    shared: false,
    filters: FILTERS,
    sort: { field: "icpScore", direction: "desc" },
    columns: ["contact", "company", "icpScore"],
    position: 0,
    ...over,
  };
}

describe("who can see a view", () => {
  it("shows a personal view only to its owner", () => {
    expect(canSeeView(view(), "fanni")).toBe(true);
    expect(canSeeView(view(), "tamas")).toBe(false);
  });

  it("shows a shared view to everyone in the workspace", () => {
    const shared = view({ shared: true });
    expect(canSeeView(shared, "fanni")).toBe(true);
    expect(canSeeView(shared, "tamas")).toBe(true);
  });
});

describe("who can edit a view", () => {
  it("lets the creator edit their own", () => {
    expect(canEditView(view(), "fanni", "BDR")).toBe(true);
  });

  it("does not let one BDR edit another's personal view", () => {
    expect(canEditView(view(), "tamas", "BDR")).toBe(false);
  });

  it("does not let a BDR edit someone else's SHARED view either", () => {
    // Being able to see a shared tab is not the same as being able to redefine
    // it under the person who made it.
    expect(canEditView(view({ shared: true }), "tamas", "BDR")).toBe(false);
  });

  it("lets an Owner or Admin curate the workspace's shared tabs", () => {
    expect(canEditView(view({ shared: true }), "tamas", "OWNER")).toBe(true);
    expect(canEditView(view({ shared: true }), "tamas", "ADMIN")).toBe(true);
  });
});

describe("view names", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeViewName("  Hot   leads  ")).toBe("Hot leads");
  });

  it("rejects an empty name", () => {
    expect(normalizeViewName("   ")).toBeNull();
    expect(normalizeViewName("")).toBeNull();
  });

  it("caps a name at a length a tab can render", () => {
    const long = normalizeViewName("x".repeat(200));
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(60);
  });
});

describe("which tab is highlighted", () => {
  const v = view();

  it("matches when filter, sort and columns all agree", () => {
    expect(viewMatchesState(v, v.filters, v.sort, v.columns)).toBe(true);
  });

  it("does not match once the filter is edited", () => {
    expect(viewMatchesState(v, { match: "all", conditions: [] }, v.sort, v.columns)).toBe(false);
  });

  it("does not match once the sort changes", () => {
    expect(viewMatchesState(v, v.filters, DEFAULT_SORT, v.columns)).toBe(false);
  });

  it("does not match once the columns change", () => {
    expect(viewMatchesState(v, v.filters, v.sort, [...DEFAULT_COLUMNS])).toBe(false);
  });

  it("ignores the ORDER of conditions, which the user never chose", () => {
    // Two conditions added in the other order describe the same question.
    const a: FilterSet = {
      match: "all",
      conditions: [
        { field: "stage", operator: "is", value: "RESEARCHED" },
        { field: "icpScore", operator: "gte", value: 3 },
      ],
    };
    const b: FilterSet = { match: "all", conditions: [...a.conditions].reverse() };
    const saved = view({ filters: a });
    expect(viewMatchesState(saved, b, saved.sort, saved.columns)).toBe(true);
  });
});

describe("opening a view", () => {
  it("produces the query string the table reads", () => {
    const q = viewToQuery(view());
    expect(q.get("view")).toBe("v1");
    expect(q.get("sort")).toBe("icpScore:desc");
    expect(q.get("cols")).toBe("contact,company,icpScore");
    expect(JSON.parse(q.get("f")!)).toEqual(FILTERS);
  });

  it("omits the filter parameter for a view that filters nothing", () => {
    const q = viewToQuery(view({ filters: { match: "all", conditions: [] } }));
    expect(q.get("f")).toBeNull();
  });

  it("always starts a view on page one", () => {
    expect(viewToQuery(view()).get("page")).toBeNull();
  });
});
