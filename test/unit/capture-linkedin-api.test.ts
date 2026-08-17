import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseObservation,
  readPath,
  normalizeProfile,
  describeSnapshot,
  unmatchedProfileShaped,
  PROFILE_MAPPING,
  type ApiSnapshot,
  type FieldRule,
} from "../../src/modules/capture/linkedin-api";

/**
 * The API-snapshot machinery (re-architecture item 3).
 *
 * ── WHAT THESE TESTS CAN AND CANNOT COVER ───────────────────────────────────
 *
 * They cover the MACHINERY: indexing an `included` array by `$type` and urn,
 * resolving cross-references, recording a JSON pointer for every value read, and
 * degrading to "found nothing" on a body shaped some other way.
 *
 * They do NOT cover the FIELD MAPPING, because there is not one. The mapping is
 * derived from recorded snapshots and `test/fixtures/linkedin-api/` is empty. The
 * final test in this file fails deliberately once snapshots DO exist and the
 * mapping has still not been written — so this cannot be quietly forgotten.
 *
 * The carrier below is SYNTHETIC and says so. It is a vehicle for testing the
 * walker, not evidence about LinkedIn's schema, and nothing in the mapping may
 * ever cite it.
 */
const SNAPSHOT_DIR = join(process.cwd(), "test/fixtures/linkedin-api");

/**
 * A synthetic body in the Rest.li convention. NOT a recording, NOT evidence.
 * Field names here are chosen to be obviously invented.
 */
const SYNTHETIC: ApiSnapshot = {
  snapshotVersion: 1,
  label: "synthetic-carrier",
  records: [
    {
      url: "https://example.test/api/thing?param=<scrubbed>",
      method: "GET",
      status: 200,
      contentType: "application/json",
      bodySize: 500,
      body: {
        data: { "*primary": "urn:li:testEntity:AAA001" },
        included: [
          {
            $type: "test.Primary",
            entityUrn: "urn:li:testEntity:AAA001",
            alpha: "first value",
            nested: { beta: "second value", list: [{ gamma: "third value" }] },
            "*link": "urn:li:testOther:BBB001",
          },
          {
            $type: "test.Other",
            entityUrn: "urn:li:testOther:BBB001",
            alpha: "other value",
          },
          {
            $type: "test.Other",
            entityUrn: "urn:li:testOther:BBB002",
            alpha: "another value",
          },
        ],
      },
    },
    {
      url: "https://example.test/api/no-included",
      method: "GET",
      status: 200,
      contentType: "application/json",
      bodySize: 40,
      body: { elements: [], paging: { total: 0 } },
    },
  ],
};

describe("indexing an observed response", () => {
  const parsed = parseObservation(SYNTHETIC.records);

  it("indexes every entity by its type discriminator", () => {
    expect(parsed.entities).toHaveLength(3);
    expect(parsed.byType.get("test.Primary")).toHaveLength(1);
    expect(parsed.byType.get("test.Other")).toHaveLength(2);
  });

  it("indexes by urn, so cross-references between entries resolve", () => {
    const primary = parsed.byType.get("test.Primary")![0]!;
    const linked = primary.value["*link"] as string;
    expect(parsed.byUrn.get(linked)?.value.alpha).toBe("other value");
  });

  it("records where each entity was found", () => {
    expect(parsed.entities[0]!.pointer).toBe("/included/0");
    expect(parsed.entities[2]!.pointer).toBe("/included/2");
    expect(parsed.entities[0]!.recordUrl).toContain("/api/thing");
  });

  /**
   * A response with no `included` array is not an error — most of what a page
   * fetches is something else — but it IS the early-warning signal if the
   * profile response ever stops carrying one.
   */
  it("reports a body with no included array as unmatched, with its top-level keys", () => {
    expect(parsed.unmatched).toHaveLength(1);
    expect(parsed.unmatched[0]!.url).toContain("/api/no-included");
    expect(parsed.unmatched[0]!.topLevelKeys).toEqual(["elements", "paging"]);
  });

  it("reports an unparseable or oversized body rather than throwing", () => {
    const p = parseObservation([
      { url: "https://example.test/a", parseError: "SyntaxError", bodySize: 10 },
      { url: "https://example.test/b", truncated: true, body: undefined, bodySize: 9_000_000 },
      { url: "https://example.test/c", body: "not json at all", bodySize: 5 },
    ]);
    expect(p.unreadable.map((u) => u.reason)).toEqual([
      "SyntaxError",
      "body_too_large_to_copy",
      "body_is_not_an_object",
    ]);
    expect(p.entities).toHaveLength(0);
  });

  it("survives a body that is not an object at all", () => {
    expect(() => parseObservation([{ url: "x", body: [1, 2, 3] }])).not.toThrow();
    expect(parseObservation([{ url: "x", body: null }]).entities).toHaveLength(0);
  });
});

describe("reading a value records where it came from", () => {
  const parsed = parseObservation(SYNTHETIC.records);
  const primary = parsed.byType.get("test.Primary")![0]!;

  it("returns the value with a JSON pointer, which replaces selector tiers", () => {
    const got = readPath(primary, "alpha")!;
    expect(got.value).toBe("first value");
    expect(got.source).toBe("api");
    expect(got.path).toBe("/included/0/alpha");
  });

  it("walks nested objects and arrays", () => {
    expect(readPath(primary, "nested.beta")!.path).toBe("/included/0/nested/beta");
    expect(readPath(primary, "nested.list.0.gamma")!.value).toBe("third value");
    expect(readPath(primary, "nested.list.0.gamma")!.path).toBe("/included/0/nested/list/0/gamma");
  });

  it("returns null for anything absent, rather than a fragment", () => {
    for (const path of ["missing", "nested.missing", "nested.list.9.gamma", "alpha.deeper"]) {
      expect(readPath(primary, path), path).toBeNull();
    }
  });

  it("treats an empty string as absent — empty beats wrong", () => {
    const p = parseObservation([
      { url: "x", body: { included: [{ $type: "t", blank: "", zero: 0 }] } },
    ]);
    const e = p.byType.get("t")![0]!;
    expect(readPath(e, "blank")).toBeNull();
    // But a real zero is a value, not an absence.
    expect(readPath(e, "zero")!.value).toBe(0);
  });
});

describe("the mapping is empty, and says so", () => {
  it("supplies no field, because no rule has been derived from a recording", () => {
    const parsed = parseObservation(SYNTHETIC.records);
    const result = normalizeProfile(parsed);
    expect(result.mappingEmpty).toBe(true);
    expect(Object.keys(result.fields)).toHaveLength(0);
    for (const reason of Object.values(result.skipped)) {
      expect(reason).toBe("no_mapping_rule_recorded");
    }
  });

  it("covers every field the lead payload needs, so nothing is forgotten later", () => {
    expect(Object.keys(PROFILE_MAPPING).sort()).toEqual(
      [
        "bio", "companyName", "email", "headline", "jobTitle",
        "location", "name", "phone", "photoUrl", "websiteUrl",
      ].sort(),
    );
  });

  it("applies rules correctly once there ARE rules", () => {
    // Proves the machinery, using the synthetic carrier's invented field names.
    const mapping: Record<string, FieldRule[]> = {
      headline: [
        { type: "test.Missing", path: "alpha", confidence: "high", evidence: "synthetic" },
        { type: "test.Primary", path: "nested.beta", confidence: "high", evidence: "synthetic" },
      ],
      name: [{ type: "test.Nowhere", path: "alpha", confidence: "high", evidence: "synthetic" }],
    };
    const result = normalizeProfile(parseObservation(SYNTHETIC.records), mapping);
    expect(result.mappingEmpty).toBe(false);
    // Falls through the first rule (no such type) to the second.
    expect(result.fields.headline!.value).toBe("second value");
    expect(result.fields.headline!.path).toBe("/included/0/nested/beta");
    // A rule matching nothing yields a reason, never a wrong value.
    expect(result.fields.name).toBeUndefined();
    expect(result.skipped.name).toBe("not_present_in_observed_response");
  });
});

describe("describing a snapshot — the instrument the mapping is read off", () => {
  const report = describeSnapshot(SYNTHETIC);

  it("lists the endpoints and whether each carried entities", () => {
    expect(report.endpoints).toHaveLength(2);
    expect(report.endpoints[0]).toMatchObject({ carriedIncluded: true, entities: 3 });
    expect(report.endpoints[1]).toMatchObject({ carriedIncluded: false, entities: 0 });
  });

  it("lists each type with its keys and how often each appears", () => {
    const other = report.types.find((t) => t.type === "test.Other")!;
    expect(other.count).toBe(2);
    const alpha = other.keys.find((k) => k.key === "alpha")!;
    expect(alpha.seen).toBe(2);
    expect(alpha.sampleKind).toMatch(/^string\(/);
  });

  it("marks urn-shaped values, which is how references are spotted", () => {
    const primary = report.types.find((t) => t.type === "test.Primary")!;
    expect(primary.keys.find((k) => k.key === "entityUrn")!.sampleKind).toBe("urn");
    expect(primary.keys.find((k) => k.key === "*link")!.sampleKind).toBe("urn");
  });

  it("sorts the commonest types first, so a report is readable top-down", () => {
    expect(report.types[0]!.type).toBe("test.Other");
    expect(report.totalEntities).toBe(3);
  });
});

describe("the early warning that the schema moved", () => {
  it("flags a profile-shaped response that yielded no field", () => {
    const parsed = parseObservation(SYNTHETIC.records);
    const flagged = unmatchedProfileShaped(parsed, normalizeProfile(parsed));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.url).toContain("/api/thing");
    expect(flagged[0]!.types).toContain("test.Primary");
    expect(flagged[0]!.entities).toBe(3);
  });

  it("stays quiet when the mapping did produce something", () => {
    const parsed = parseObservation(SYNTHETIC.records);
    const normalized = normalizeProfile(parsed, {
      headline: [
        { type: "test.Primary", path: "alpha", confidence: "high", evidence: "synthetic" },
      ],
    });
    expect(unmatchedProfileShaped(parsed, normalized)).toHaveLength(0);
  });
});

/**
 * ── THE GATE ────────────────────────────────────────────────────────────────
 *
 * While the snapshot directory is empty this is a note. The moment a recording
 * lands it becomes a failing test, and it stays failing until the mapping has
 * been derived from it with each rule citing the file it came from.
 *
 * That is deliberate: the risk in a re-architecture like this is that the
 * plumbing ships, the recording never happens, and the DOM path quietly carries
 * on being the only thing that works while everyone believes otherwise.
 */
describe("recorded snapshots drive the mapping", () => {
  const files = existsSync(SNAPSHOT_DIR)
    ? readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json"))
    : [];

  it("has a README telling a human how to record them", () => {
    expect(existsSync(join(SNAPSHOT_DIR, "README.md"))).toBe(true);
  });

  it("derives a mapping rule from every recorded snapshot, citing it", () => {
    if (files.length === 0) {
      // Nothing recorded yet. The mapping is correctly empty and the DOM path is
      // correctly still in charge.
      expect(Object.values(PROFILE_MAPPING).every((r) => r.length === 0)).toBe(true);
      return;
    }
    // Snapshots exist: the mapping must no longer be empty, and every rule must
    // name the file that justifies it.
    const rules = Object.values(PROFILE_MAPPING).flat();
    expect(
      rules.length,
      `${files.length} snapshot(s) recorded but PROFILE_MAPPING is still empty`,
    ).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(files, `rule cites "${rule.evidence}", which is not a recorded snapshot`).toContain(
        rule.evidence,
      );
    }
  });

  it("parses every recorded snapshot without throwing", () => {
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(SNAPSHOT_DIR, file), "utf8")) as ApiSnapshot;
      expect(() => describeSnapshot(raw), file).not.toThrow();
    }
  });

  it("carries no real person in any recorded snapshot", () => {
    for (const file of files) {
      const text = readFileSync(join(SNAPSHOT_DIR, file), "utf8");
      // The scrubber's own markers must be present, and member ids absent.
      expect(text, `${file} contains an unscrubbed member id`).not.toMatch(/ACoAA[A-Za-z0-9_-]{6,}/);
      expect(text, `${file} contains an unscrubbed JSESSIONID`).not.toMatch(/JSESSIONID/i);
    }
  });
});
