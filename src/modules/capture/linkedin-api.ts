/**
 * Reading a recorded LinkedIn API snapshot.
 *
 * ── WHAT IS HERE, AND WHAT IS DELIBERATELY NOT ──────────────────────────────
 *
 * HERE: the machinery. Parsing observed records, walking the `included` graph,
 * indexing entities by their `$type` discriminator and by urn, resolving the
 * cross-references entries make to each other, and recording a JSON pointer for
 * every value read.
 *
 * NOT HERE: the field mapping. `PROFILE_MAPPING` is empty, and it stays empty
 * until snapshots exist in `test/fixtures/linkedin-api/`.
 *
 * That emptiness is the point. Six rounds of DOM fixes failed by reasoning about
 * a shape rather than looking at one, and the re-architecture is only worth doing
 * if it does not repeat that. LinkedIn's response schema is theirs and
 * undocumented; a mapping written from a plausible guess would be wrong in a new
 * way and would look right until a capture came back empty.
 *
 * So `describeSnapshot` exists first: point it at a recorded file and it reports
 * which `$type`s are present, which keys each carries, and which entries
 * cross-reference which — the evidence a mapping is derived FROM. When the
 * snapshots land, the table below gets filled in from what they actually contain,
 * and every entry cites the snapshot that justifies it.
 *
 * ── WHY `included` AT ALL ───────────────────────────────────────────────────
 *
 * This module assumes exactly one thing about the schema: that a response may
 * carry a flat array of entities under `included`, each tagged with a `$type`,
 * referring to one another by urn. That is a property of the Rest.li / Voyager
 * convention rather than of any particular endpoint, and everything here degrades
 * to "found nothing" rather than throwing when a body is shaped some other way.
 */

export interface ObservedRecord {
  url: string;
  method?: string;
  status?: number;
  contentType?: string;
  bodySize?: number;
  truncated?: boolean;
  /** Parsed body when the snapshot carried one; a string when still raw. */
  body?: unknown;
  parseError?: string | null;
}

export interface ApiSnapshot {
  snapshotVersion?: number;
  label?: string | null;
  slugShape?: { tokens: number; abbreviated: boolean } | null;
  recordCount?: number;
  records: ObservedRecord[];
}

/** One entity out of an `included` array, with where it was found. */
export interface Entity {
  type: string | null;
  urn: string | null;
  value: Record<string, unknown>;
  /** JSON pointer to this entity, e.g. `/included/12`. */
  pointer: string;
  /** Which observed record it came from. */
  recordUrl: string;
}

export interface ParsedObservation {
  entities: Entity[];
  /** `$type` → entities carrying it. */
  byType: Map<string, Entity[]>;
  /** urn → entity, for resolving the references entries make to each other. */
  byUrn: Map<string, Entity>;
  /** Records that parsed but carried no `included` array. */
  unmatched: { url: string; topLevelKeys: string[]; bodySize: number }[];
  /** Records that could not be parsed at all. */
  unreadable: { url: string; reason: string }[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 6901 escaping, so a pointer can be quoted back verbatim in diagnostics. */
function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function bodyOf(record: ObservedRecord): unknown {
  if (typeof record.body === "string") {
    try {
      return JSON.parse(record.body);
    } catch {
      return null;
    }
  }
  return record.body ?? null;
}

/**
 * Index every entity in every observed record.
 *
 * Nothing here knows what a profile is. It knows that entities have types and
 * urns and that they point at each other, which is enough to build the index a
 * mapping is written against.
 */
export function parseObservation(records: ObservedRecord[]): ParsedObservation {
  const entities: Entity[] = [];
  const byType = new Map<string, Entity[]>();
  const byUrn = new Map<string, Entity>();
  const unmatched: ParsedObservation["unmatched"] = [];
  const unreadable: ParsedObservation["unreadable"] = [];

  for (const record of records ?? []) {
    if (record.parseError) {
      unreadable.push({ url: record.url, reason: record.parseError });
      continue;
    }
    if (record.truncated && record.body == null) {
      unreadable.push({ url: record.url, reason: "body_too_large_to_copy" });
      continue;
    }
    const body = bodyOf(record);
    if (!isObject(body)) {
      unreadable.push({ url: record.url, reason: "body_is_not_an_object" });
      continue;
    }

    const included = body.included;
    if (!Array.isArray(included)) {
      unmatched.push({
        url: record.url,
        topLevelKeys: Object.keys(body),
        bodySize: record.bodySize ?? 0,
      });
      continue;
    }

    included.forEach((raw, i) => {
      if (!isObject(raw)) return;
      const type = typeof raw.$type === "string" ? raw.$type : null;
      const urn =
        typeof raw.entityUrn === "string"
          ? raw.entityUrn
          : typeof raw.objectUrn === "string"
            ? raw.objectUrn
            : null;
      const entity: Entity = {
        type,
        urn,
        value: raw,
        pointer: `/included/${i}`,
        recordUrl: record.url,
      };
      entities.push(entity);
      if (type) {
        const list = byType.get(type) ?? [];
        list.push(entity);
        byType.set(type, list);
      }
      // First writer wins: a later record re-stating the same urn is usually the
      // same entity, and replacing it would make pointers inconsistent.
      if (urn && !byUrn.has(urn)) byUrn.set(urn, entity);
    });
  }

  return { entities, byType, byUrn, unmatched, unreadable };
}

/** A value plus the JSON pointer it came from — the replacement for selector tiers. */
export interface Sourced<T> {
  value: T;
  source: "api";
  confidence: "high" | "medium";
  /** `/included/12/firstName`, quotable straight into a diagnostics report. */
  path: string;
}

/**
 * Read a dotted path out of an entity, recording the JSON pointer.
 *
 * Returns null rather than throwing on anything missing: "empty beats wrong"
 * survives the re-architecture unchanged, and a mapping that half-matches a
 * changed schema must produce nothing rather than a fragment.
 */
export function readPath(
  entity: Entity,
  path: string,
  confidence: "high" | "medium" = "high",
): Sourced<unknown> | null {
  let cursor: unknown = entity.value;
  const segments: string[] = [];
  for (const key of path.split(".")) {
    if (Array.isArray(cursor)) {
      const index = Number.parseInt(key, 10);
      if (!Number.isFinite(index) || index < 0 || index >= cursor.length) return null;
      cursor = cursor[index];
      segments.push(String(index));
      continue;
    }
    if (!isObject(cursor)) return null;
    if (!(key in cursor)) return null;
    cursor = cursor[key];
    segments.push(pointerSegment(key));
  }
  if (cursor === null || cursor === undefined || cursor === "") return null;
  return {
    value: cursor,
    source: "api",
    confidence,
    path: `${entity.pointer}/${segments.join("/")}`,
  };
}

// ---------------------------------------------------------------------------
// The mapping — EMPTY UNTIL SNAPSHOTS EXIST
// ---------------------------------------------------------------------------

export interface FieldRule {
  /** The `$type` an entity must carry. */
  type: string;
  /** Dotted path within the entity. */
  path: string;
  confidence: "high" | "medium";
  /** The recorded snapshot that justifies this rule. Never blank. */
  evidence: string;
}

/**
 * field → the rules that can supply it, in order of preference.
 *
 * DELIBERATELY EMPTY. Every entry must cite the recorded snapshot it was derived
 * from, and there are no recorded snapshots yet. `normalizeProfile` therefore
 * returns nothing for every field, which is the honest state of the world and is
 * exactly what makes the DOM path still run.
 *
 * The hints in the brief — an `included` array with `$type` discriminators, names
 * and headlines on a profile entity, positions in their own entries, a vector
 * image with a root URL and sized artifacts — are consistent with the Voyager
 * convention this module's machinery already handles. They are not written down
 * as rules here, because a hint is not evidence and a rule without evidence is
 * the guess this re-architecture exists to stop making.
 */
export const PROFILE_MAPPING: Record<string, FieldRule[]> = {
  name: [],
  headline: [],
  location: [],
  companyName: [],
  jobTitle: [],
  bio: [],
  photoUrl: [],
  email: [],
  phone: [],
  websiteUrl: [],
};

export interface NormalizedProfile {
  fields: Record<string, Sourced<unknown>>;
  /** Fields the mapping could not supply, and why. */
  skipped: Record<string, string>;
  /** True when no rule exists at all — the state before snapshots are recorded. */
  mappingEmpty: boolean;
}

/**
 * Apply the mapping to an indexed observation.
 *
 * Pure, so it can be run against a committed snapshot in a test with no browser
 * and no network — which is the entire testing story for the new path.
 */
export function normalizeProfile(
  parsed: ParsedObservation,
  mapping: Record<string, FieldRule[]> = PROFILE_MAPPING,
): NormalizedProfile {
  const fields: Record<string, Sourced<unknown>> = {};
  const skipped: Record<string, string> = {};
  const ruleCount = Object.values(mapping).reduce((n, rules) => n + rules.length, 0);

  for (const [field, rules] of Object.entries(mapping)) {
    if (rules.length === 0) {
      skipped[field] = "no_mapping_rule_recorded";
      continue;
    }
    let found: Sourced<unknown> | null = null;
    for (const rule of rules) {
      for (const entity of parsed.byType.get(rule.type) ?? []) {
        const got = readPath(entity, rule.path, rule.confidence);
        if (got) {
          found = got;
          break;
        }
      }
      if (found) break;
    }
    if (found) fields[field] = found;
    else skipped[field] = "not_present_in_observed_response";
  }

  return { fields, skipped, mappingEmpty: ruleCount === 0 };
}

// ---------------------------------------------------------------------------
// The tool that turns snapshots into a mapping
// ---------------------------------------------------------------------------

export interface TypeReport {
  type: string;
  count: number;
  /** Keys seen on entities of this type, with how often. */
  keys: { key: string; seen: number; sampleKind: string }[];
}

export interface SnapshotReport {
  label: string | null;
  recordCount: number;
  /** Endpoints observed, and whether each carried an `included` array. */
  endpoints: { url: string; bodySize: number; entities: number; carriedIncluded: boolean }[];
  types: TypeReport[];
  unmatched: ParsedObservation["unmatched"];
  unreadable: ParsedObservation["unreadable"];
  totalEntities: number;
}

/** What kind of thing a value is, for a report a human reads. */
function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (isObject(v)) return `object{${Object.keys(v).slice(0, 4).join(",")}}`;
  if (typeof v === "string") {
    if (/^urn:li:/.test(v)) return "urn";
    return `string(${v.length})`;
  }
  return typeof v;
}

/**
 * Describe a recorded snapshot: which endpoints, which types, which keys.
 *
 * This is the instrument the mapping is read off. It states what is there and
 * makes no claim about what any of it MEANS — naming a field is a judgement made
 * by a human looking at this output next to the profile it was recorded from.
 */
export function describeSnapshot(snapshot: ApiSnapshot): SnapshotReport {
  const parsed = parseObservation(snapshot.records ?? []);

  const endpoints = (snapshot.records ?? []).map((r) => {
    const body = bodyOf(r);
    const carriedIncluded = isObject(body) && Array.isArray(body.included);
    return {
      url: r.url,
      bodySize: r.bodySize ?? 0,
      entities: carriedIncluded ? (body.included as unknown[]).length : 0,
      carriedIncluded,
    };
  });

  const types: TypeReport[] = [];
  for (const [type, list] of parsed.byType) {
    const keyCounts = new Map<string, { seen: number; sampleKind: string }>();
    for (const entity of list) {
      for (const [key, value] of Object.entries(entity.value)) {
        const existing = keyCounts.get(key);
        if (existing) existing.seen += 1;
        else keyCounts.set(key, { seen: 1, sampleKind: kindOf(value) });
      }
    }
    types.push({
      type,
      count: list.length,
      keys: [...keyCounts.entries()]
        .map(([key, v]) => ({ key, seen: v.seen, sampleKind: v.sampleKind }))
        .sort((a, b) => b.seen - a.seen || a.key.localeCompare(b.key)),
    });
  }
  types.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    label: snapshot.label ?? null,
    recordCount: snapshot.records?.length ?? 0,
    endpoints,
    types,
    unmatched: parsed.unmatched,
    unreadable: parsed.unreadable,
    totalEntities: parsed.entities.length,
  };
}

/**
 * A response that looks profile-shaped but matched no rule.
 *
 * The early warning that LinkedIn changed something: a body carrying an
 * `included` array of typed entities, from which the mapping extracted nothing.
 * Reported with its URL pattern so the next recording session knows where to look.
 */
export function unmatchedProfileShaped(
  parsed: ParsedObservation,
  normalized: NormalizedProfile,
): { url: string; types: string[]; entities: number }[] {
  if (Object.keys(normalized.fields).length > 0) return [];
  const byRecord = new Map<string, Set<string>>();
  for (const e of parsed.entities) {
    if (!e.type) continue;
    const set = byRecord.get(e.recordUrl) ?? new Set<string>();
    set.add(e.type);
    byRecord.set(e.recordUrl, set);
  }
  return [...byRecord.entries()].map(([url, types]) => ({
    url,
    types: [...types].slice(0, 12),
    entities: parsed.entities.filter((e) => e.recordUrl === url).length,
  }));
}
