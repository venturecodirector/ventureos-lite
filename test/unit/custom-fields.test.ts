import { describe, it, expect } from "vitest";
import {
  OPERATORS_BY_TYPE,
  coerce,
  customFieldKey,
  customFieldRef,
  formatValue,
  isCustomFieldRef,
  isTextual,
  isValidKey,
  mergeValues,
  readValues,
  searchableValues,
  slugifyKey,
  validateValues,
  RESERVED_KEYS,
  type FieldDef,
} from "../../src/modules/fields/types";
import {
  applyFilters,
  operatorsForField,
  labelForField,
  type FilterableLead,
} from "../../src/modules/leads/filters";

function def(over: Partial<FieldDef> = {}): FieldDef {
  return {
    id: "f1",
    entity: "lead",
    key: "segment",
    label: "Segment",
    type: "TEXT",
    options: [],
    required: false,
    archived: false,
    position: 0,
    help: null,
    ...over,
  };
}

describe("keys", () => {
  it("folds Hungarian accents rather than dropping them", () => {
    expect(slugifyKey("Ügyfél típusa")).toBe("ugyfel_tipusa");
    expect(slugifyKey("Árbevétel (M Ft)")).toBe("arbevetel_m_ft");
  });

  it("rejects anything that cannot be a JSON key or a URL parameter", () => {
    expect(isValidKey("segment")).toBe(true);
    expect(isValidKey("segment_2")).toBe(true);
    expect(isValidKey("2segment")).toBe(false);
    expect(isValidKey("Segment")).toBe(false);
    expect(isValidKey("seg ment")).toBe(false);
    expect(isValidKey("")).toBe(false);
  });

  it("reserves the built-in column names", () => {
    expect(RESERVED_KEYS.has("stage")).toBe(true);
    expect(RESERVED_KEYS.has("email")).toBe(true);
    expect(RESERVED_KEYS.has("segment")).toBe(false);
  });

  it("round-trips a filter/column reference", () => {
    expect(customFieldRef("segment")).toBe("cf:segment");
    expect(isCustomFieldRef("cf:segment")).toBe(true);
    expect(isCustomFieldRef("stage")).toBe(false);
    expect(customFieldKey(customFieldRef("segment"))).toBe("segment");
  });
});

describe("validation", () => {
  it("accepts a well-formed value per type", () => {
    const defs = [
      def({ key: "note", type: "TEXT" }),
      def({ key: "size", type: "NUMBER" }),
      def({ key: "renew", type: "DATE" }),
      def({ key: "vip", type: "CHECKBOX" }),
      def({ key: "site", type: "URL" }),
      def({
        key: "band",
        type: "SELECT",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      }),
      def({
        key: "tags",
        type: "MULTISELECT",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      }),
    ];
    const res = validateValues(defs, {
      note: "hello",
      size: 42,
      renew: "2026-09-01",
      vip: true,
      site: "https://example.hu",
      band: "a",
      tags: ["x", "y"],
    });
    expect(res.ok).toBe(true);
    expect(res.values.size).toBe(42);
    expect(res.values.tags).toEqual(["x", "y"]);
  });

  it("refuses a select value that is not one of the options", () => {
    const d = def({ key: "band", type: "SELECT", options: [{ value: "a", label: "A" }] });
    const res = validateValues([d], { band: "z" });
    expect(res.ok).toBe(false);
    expect(res.problems[0].message).toMatch(/not one of the options/);
  });

  it("refuses a URL without a scheme", () => {
    const res = validateValues([def({ key: "site", type: "URL" })], { site: "example.hu" });
    expect(res.ok).toBe(false);
  });

  it("refuses a key the workspace has never defined", () => {
    const res = validateValues([def()], { nope: "x" });
    expect(res.ok).toBe(false);
    expect(res.problems[0].message).toMatch(/not a field/);
  });

  it("refuses a write to an archived field, and says why", () => {
    const res = validateValues([def({ archived: true })], { segment: "retail" });
    expect(res.ok).toBe(false);
    expect(res.problems[0].message).toMatch(/archived/);
  });

  it("treats a blank as clearing, unless the field is required", () => {
    expect(validateValues([def()], { segment: "" }).values.segment).toBeNull();
    const required = validateValues([def({ required: true })], { segment: "" });
    expect(required.ok).toBe(false);
    expect(required.problems[0].message).toBe("is required");
  });

  it("is partial: a patch that omits a required field is fine, a create is not", () => {
    const defs = [def({ key: "a" }), def({ key: "b", required: true })];
    expect(validateValues(defs, { a: "x" }).ok).toBe(true);
    expect(validateValues(defs, { a: "x" }, { full: true }).ok).toBe(false);
  });

  it("coerces what a form control or a spreadsheet cell actually sends", () => {
    expect(coerce(def({ type: "NUMBER" }), "1 234,5")).toBe(1234.5);
    expect(coerce(def({ type: "CHECKBOX" }), "igen")).toBe(true);
    expect(coerce(def({ type: "CHECKBOX" }), "nem")).toBe(false);
    expect(coerce(def({ type: "MULTISELECT" }), "x; y|z")).toEqual(["x", "y", "z"]);
    expect(coerce(def({ type: "DATE" }), "2026-09-01T10:00:00Z")).toBe("2026-09-01");
  });
});

describe("stored values", () => {
  it("reads a hostile column defensively", () => {
    expect(readValues(null)).toEqual({});
    expect(readValues("nope")).toEqual({});
    expect(readValues([1, 2])).toEqual({});
    expect(readValues({ a: 1 })).toEqual({ a: 1 });
  });

  it("merges a patch and drops cleared keys", () => {
    expect(mergeValues({ a: "1", b: "2" }, { b: null, c: "3" })).toEqual({ a: "1", c: "3" });
  });

  it("formats for a cell the way a person reads it", () => {
    expect(formatValue(def({ type: "CHECKBOX" }), true)).toBe("yes");
    expect(formatValue(def({ type: "CHECKBOX" }), false)).toBe("no");
    expect(
      formatValue(
        def({ type: "SELECT", options: [{ value: "a", label: "Alpha" }] }),
        "a",
      ),
    ).toBe("Alpha");
    expect(
      formatValue(
        def({
          type: "MULTISELECT",
          options: [
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ],
        }),
        ["a", "b"],
      ),
    ).toBe("Alpha, Beta");
    expect(formatValue(def(), null)).toBe("");
  });

  it("only offers textual values to the search index", () => {
    const defs = [
      def({ key: "note", type: "TEXT" }),
      def({ key: "size", type: "NUMBER" }),
      def({ key: "site", type: "URL" }),
    ];
    expect(isTextual("TEXT")).toBe(true);
    expect(isTextual("NUMBER")).toBe(false);
    expect(searchableValues(defs, { note: "Danubia", size: 5, site: "https://x.hu" })).toEqual([
      "Danubia",
      "https://x.hu",
    ]);
  });
});

describe("the filter engine sees custom fields", () => {
  function lead(customFields: Record<string, unknown>): FilterableLead {
    return {
      id: "l1",
      contactName: "Anna",
      title: null,
      email: null,
      phone: null,
      company: null,
      industry: null,
      city: null,
      icpScore: null,
      stage: "RESEARCHED",
      signals: [],
      source: "MANUAL",
      ownerId: null,
      lastActivityAt: null,
      createdAt: new Date("2026-01-01"),
      customFields,
    };
  }

  const specs = [
    { key: "segment", type: "TEXT" as const, label: "Segment" },
    { key: "size", type: "NUMBER" as const, label: "Size" },
    { key: "vip", type: "CHECKBOX" as const, label: "VIP" },
    { key: "band", type: "SELECT" as const, label: "Band" },
    { key: "tags", type: "MULTISELECT" as const, label: "Tags" },
  ];

  const rows = [
    lead({ segment: "HoReCa", size: 30, vip: true, band: "a", tags: ["x"] }),
    { ...lead({ segment: "Retail", size: 5, vip: false, band: "b", tags: ["y"] }), id: "l2" },
    { ...lead({}), id: "l3" },
  ];

  const run = (c: Parameters<typeof applyFilters>[1]["conditions"][number]) =>
    applyFilters(rows, { match: "all", conditions: [c] }, new Date("2026-02-01"), specs).map(
      (r) => r.id,
    );

  it("matches text accent- and case-insensitively", () => {
    expect(run({ field: "cf:segment", operator: "contains", value: "horeca" })).toEqual(["l1"]);
  });

  it("compares numbers", () => {
    expect(run({ field: "cf:size", operator: "gte", value: 10 })).toEqual(["l1"]);
    expect(run({ field: "cf:size", operator: "between", min: 1, max: 10 })).toEqual(["l2"]);
  });

  it("answers is_set / is_not_set", () => {
    expect(run({ field: "cf:segment", operator: "is_set" })).toEqual(["l1", "l2"]);
    expect(run({ field: "cf:segment", operator: "is_not_set" })).toEqual(["l3"]);
  });

  it("handles checkbox, select and multi-select", () => {
    expect(run({ field: "cf:vip", operator: "is_true" })).toEqual(["l1"]);
    expect(run({ field: "cf:band", operator: "is", value: "b" })).toEqual(["l2"]);
    expect(run({ field: "cf:tags", operator: "has_any_of", values: ["y"] })).toEqual(["l2"]);
    expect(run({ field: "cf:tags", operator: "has_none_of", values: ["x"] })).toEqual([
      "l2",
      "l3",
    ]);
  });

  it("treats an unknown custom field as inert rather than exclusionary", () => {
    // A saved view written before a field was archived must not silently empty
    // the table.
    expect(run({ field: "cf:gone", operator: "is", value: "x" })).toEqual(["l1", "l2", "l3"]);
  });

  it("offers each type its own operators, and mirrors the fields module", () => {
    for (const spec of specs) {
      expect(operatorsForField(`cf:${spec.key}`, specs)).toEqual(OPERATORS_BY_TYPE[spec.type]);
    }
    expect(operatorsForField("cf:unknown", specs)).toEqual([]);
  });

  it("labels a custom condition with the field's own label", () => {
    expect(labelForField("cf:segment", specs)).toBe("Segment");
    expect(labelForField("cf:gone", specs)).toBe("gone");
    expect(labelForField("stage", specs)).toBe("Stage");
  });
});
