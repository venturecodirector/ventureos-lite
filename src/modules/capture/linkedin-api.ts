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

// ---------------------------------------------------------------------------
// The RSC flight mapping — DERIVED FROM RECORDED SNAPSHOTS
// ---------------------------------------------------------------------------

/**
 * ── WHAT THE RECORDING ACTUALLY SHOWED ──────────────────────────────────────
 *
 * Everything above assumes the Voyager convention: a flat `included` array of
 * entities, each tagged with a `$type`, referring to one another by urn. The
 * first two recorded snapshots contain none of that.
 *
 * LinkedIn's profile is React Server Components. The payload is numbered rows of
 * JSON fragments, each row a React element tree, and there are no `$type`
 * entities to key off. What there IS — and this is what makes a mapping possible
 * at all — is a stable tracking discriminator on each meaningful subtree:
 *
 *     viewTrackingSpecs.viewName        "contact-email"  "contact-phone"  "contact-website"
 *     viewTrackingSpecs.legacyControlName  "contact_email"  "contact_call"   "contact_website"
 *
 * Two independent names for the same node, neither of them localised — which
 * matters, because the visible labels on this account are Hungarian and a mapping
 * keyed on label text would work in one language and silently fail in the other.
 *
 * The values sit in different shapes per field, and that is not a guess either:
 *
 *     email    a navigate action's url:  "mailto:<address>"
 *     phone    a text child of the row:  ["+36…"]
 *     website  a navigate action's url:  "https://…"
 *
 * Every rule below cites the snapshot it was read out of. A rule with no
 * evidence is the guess this whole re-architecture exists to stop making.
 */

export interface FlightRule {
  /** Dotted path, within a candidate node, to the discriminating value. */
  discriminatorPath?: string;
  /** The value that path must hold for the node to be the one we want. */
  discriminator?: string;
  /**
   * Or: the node is identified by CARRYING these keys.
   *
   * The recording put the profile's name in objects with explicit `firstName`
   * and `lastName` keys — no tracked view anywhere near them. Where a key names
   * the field there is nothing to discriminate on, and nothing to guess either.
   */
  keys?: string[];
  /** Which shape of value to look for below the node. */
  extract: keyof typeof EXTRACTORS | "keys";
  /**
   * Which records may answer.
   *
   * `profile-document` restricts a rule to the record whose url IS the profile
   * page — because one capture can hold several people. A session that walks
   * from one profile to another leaves both in the buffer, and a rule that took
   * the first `firstName` it found would attach the wrong person's name to the
   * right person's lead. That is not hypothetical: the recorded snapshot holds
   * two.
   */
  scope?: "any" | "profile-document";
  confidence: "high" | "medium";
  /** The recorded snapshot that justifies this rule. Never blank. */
  evidence: string;
}

export const FLIGHT_MAPPING: Record<string, FlightRule[]> = {
  name: [
    {
      // `{ firstName, lastName }`, in the record that IS the profile page.
      keys: ["firstName", "lastName"],
      extract: "keys",
      scope: "profile-document",
      confidence: "high",
      evidence: "profile-full.json",
    },
    {
      // The greeting form, when the pair is not there. Lower confidence: it is
      // a first name only, and the capture wants a full one.
      keys: ["familiarName"],
      extract: "keys",
      scope: "profile-document",
      confidence: "medium",
      evidence: "profile-full.json",
    },
  ],
  email: [
    {
      discriminatorPath: "viewTrackingSpecs.viewName",
      discriminator: "contact-email",
      extract: "mailto",
      confidence: "high",
      evidence: "contact-overlay.json",
    },
    {
      // The same node, by its other name. Kept as a second rule rather than an
      // either/or inside the first, so that if LinkedIn drops one of the two the
      // diagnostics say which one went.
      discriminatorPath: "viewTrackingSpecs.legacyControlName",
      discriminator: "contact_email",
      extract: "mailto",
      confidence: "medium",
      evidence: "contact-overlay.json",
    },
  ],
  phone: [
    {
      discriminatorPath: "viewTrackingSpecs.viewName",
      discriminator: "contact-phone",
      extract: "phone",
      confidence: "high",
      evidence: "contact-overlay.json",
    },
    {
      discriminatorPath: "viewTrackingSpecs.legacyControlName",
      discriminator: "contact_call",
      extract: "phone",
      confidence: "medium",
      evidence: "contact-overlay.json",
    },
  ],
  /**
   * NOT MAPPED YET, and deliberately so.
   *
   * The recorded overlay HAS a `contact-website` node — the discriminator is
   * witnessed — but this person has no website on their panel, so the only
   * http url in the whole record is their own LinkedIn profile link. That means
   * the shape a real website value arrives in is NOT witnessed, and writing the
   * rule from the two that are would be exactly the guess this module refuses to
   * make. It needs one snapshot from a profile that has a website.
   */
  websiteUrl: [],
};

/** A parsed flight body, as the scrubber and the observer both produce it. */
export interface FlightBody {
  format: string;
  rows: Array<{ id: string | null; tag: string | null; value?: unknown }>;
}

/** Depth-limited walk over a React element tree. */
function* walkNodes(value: unknown, path = "", depth = 0): Generator<[string, Record<string, unknown>]> {
  if (depth > 60 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      yield* walkNodes(value[i], `${path}/${i}`, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    yield [path, value as Record<string, unknown>];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      yield* walkNodes(v, `${path}/${k}`, depth + 1);
    }
  }
}

function at(node: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = node;
  for (const key of dotted.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * A reference to another row: `$L1b`, `$1b`, `$Lf`.
 *
 * ── THE PIECE WITHOUT WHICH NONE OF THIS WORKS ──────────────────────────────
 *
 * The recorded payload put the discriminator and the value in DIFFERENT ROWS.
 * `contact-email` sits in row 19; the address it belongs to is in row 1b, as
 * `mailto:…` inside a navigate action. Row 19 reaches it by the string `"$L1b"`.
 *
 * A plain subtree walk from the discriminator therefore finds nothing — which it
 * did, on the first run of the mapping against the real fixture. Following the
 * references is not an optimisation; it is the difference between a mapping that
 * works and one that silently returns empty.
 */
const ROW_REF = /^\$L?([0-9a-f]{1,4})$/;

/**
 * Every string below a node, in document order, following row references.
 *
 * Bounded three ways, because a payload we do not control must not be able to
 * hang a capture: a depth limit, a visited set for the rows (references can form
 * cycles), and a cap on how many strings are yielded at all.
 */
/**
 * Subtrees that are metadata by definition, and are never a field's value.
 *
 * `viewTrackingSpecs` holds the discriminator we matched ON, plus a base64
 * `contentTrackingId`. Walking into it is how the first version of this
 * extractor came back with `gpRhtA9jSFObSQRBJwS5vQ==` as somebody's phone
 * number — and the test passed, because it only checked that SOMETHING was found
 * at that position.
 */
const METADATA_KEYS = new Set(["viewTrackingSpecs", "visibilityTriggers", "componentKey", "componentkey"]);

function* stringsUnder(
  value: unknown,
  rows?: Map<string, unknown>,
  depth = 0,
  seen: Set<string> = new Set(),
  budget = { left: 4000 },
): Generator<string> {
  if (depth > 60 || budget.left <= 0 || value === null || value === undefined) return;
  if (typeof value === "string") {
    budget.left -= 1;
    const ref = rows ? ROW_REF.exec(value) : null;
    if (ref) {
      const id = ref[1]!;
      // A row is followed once per walk. Twice would be a cycle.
      if (!seen.has(id) && rows!.has(id)) {
        seen.add(id);
        yield* stringsUnder(rows!.get(id), rows, depth + 1, seen, budget);
      }
      return;
    }
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) yield* stringsUnder(v, rows, depth + 1, seen, budget);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (METADATA_KEYS.has(k)) continue;
      yield* stringsUnder(v, rows, depth + 1, seen, budget);
    }
  }
}

/**
 * ── EVERY RULE SAYS WHAT SHAPE IT IS LOOKING FOR ────────────────────────────
 *
 * The first version of this extractor took "the first string that does not look
 * like scaffolding". Run against the raw payload it would have returned
 * `gpRhtA9jSFObSQRBJwS5vQ==` — a tracking id — as the phone number, and the
 * fixture test passed anyway because it only asserted that something was found.
 * A plausible wrong answer with a green test is the exact failure mode this
 * module exists to prevent, so the heuristic is gone.
 *
 * Each extractor now recognises its own kind. A predicate also accepts the
 * SCRUBBER'S PLACEHOLDER for that kind — deliberately, and this is the only
 * concession to testing in here: a committed fixture holds `<phone>` where a
 * number was, and without that the locator could not be tested against the
 * recorded evidence at all. Placeholders never occur in live payloads.
 */
const EXTRACTORS = {
  /** An address inside a `mailto:` url. */
  mailto: (s: string): string | null => (/^mailto:/i.test(s) ? s.slice("mailto:".length) : null),
  /** An http(s) url. The scrubbed form `https://<host>/…` matches the same test. */
  url: (s: string): string | null => (/^https?:\/\//i.test(s) ? s : null),
  /** A phone number, or the placeholder that stands in for one. */
  phone: (s: string): string | null =>
    s === "<phone>" || /^\+?\d[\d ()/-]{7,}$/.test(s) ? s : null,
} as const;

export interface FlightField {
  value: string;
  source: "api";
  confidence: "high" | "medium";
  /** Where it was found, for the diagnostics. */
  path: string;
  /** Which discriminator matched, so a failure names the rule that stopped working. */
  via: string;
}

/**
 * Read the fields the mapping knows about out of a set of flight bodies.
 *
 * Returns only what it FOUND. A field with no rule, or a rule whose
 * discriminator is absent, is simply missing — never a guess, and never a throw.
 */
/** A record as the observer and the scrubber both carry it. */
export interface FlightRecord {
  url: string;
  body: FlightBody | null;
}

/**
 * Read the fields the mapping knows about out of a set of recorded records.
 *
 * Returns only what it FOUND. A field with no rule, or a rule whose
 * discriminator is absent, is simply missing — never a guess, and never a throw.
 *
 * `slug` scopes the rules that need it: one capture can hold two people, so a
 * rule marked `profile-document` only reads the record whose url is that
 * person's page.
 */
export function normalizeFlight(
  records: FlightRecord[],
  opts: { slug?: string } = {},
): Record<string, FlightField> {
  const out: Record<string, FlightField> = {};
  const slug = opts.slug?.toLowerCase() ?? null;

  const isProfileDocument = (url: string): boolean => {
    const match = /\/in\/([^/?#]+)/i.exec(url);
    if (!match) return false;
    return slug === null ? true : decodeURIComponent(match[1]!).toLowerCase() === slug;
  };

  for (const [field, rules] of Object.entries(FLIGHT_MAPPING)) {
    for (const rule of rules) {
      if (out[field]) break;
      for (const record of records) {
        if (out[field]) break;
        if (rule.scope === "profile-document" && !isProfileDocument(record.url)) continue;
        const body = record.body;
        // Row id → value, so a reference can be followed to the row it names.
        const rowsById = new Map<string, unknown>(
          (body?.rows ?? [])
            .filter((r) => r.id !== null && r.value !== undefined)
            .map((r) => [String(r.id), r.value]),
        );
        for (const row of body?.rows ?? []) {
          if (out[field]) break;
          for (const [path, node] of walkNodes(row.value, `/rows/${row.id}`)) {
            let value: string | null = null;
            let via = "";

            if (rule.extract === "keys") {
              const wanted = rule.keys ?? [];
              if (!wanted.every((k) => typeof node[k] === "string" && node[k] !== "")) continue;
              value = wanted.map((k) => String(node[k])).join(" ");
              via = `keys=${wanted.join("+")}`;
            } else {
              if (
                !rule.discriminatorPath ||
                at(node, rule.discriminatorPath) !== rule.discriminator
              ) {
                continue;
              }
              const recognise = EXTRACTORS[rule.extract];
              for (const candidate of stringsUnder(node, rowsById)) {
                const hit = recognise(candidate);
                if (hit) {
                  value = hit;
                  break;
                }
              }
              via = `${rule.discriminatorPath}=${rule.discriminator}`;
            }
            if (!value) continue;

            out[field] = {
              value,
              source: "api",
              confidence: rule.confidence,
              path,
              via,
            };
            break;
          }
        }
      }
    }
  }
  return out;
}
