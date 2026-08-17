/**
 * Reading and writing the table's state (playbook-v2 P3/2).
 *
 * The same filter set has to survive two hostile round-trips: the URL — so a
 * filtered table is linkable, bookmarkable and survives a refresh — and the
 * `saved_views.filters` JSON column, which a stale row or a hand-edited record
 * can arrive from.
 *
 * So PARSING IS TOTAL. It never throws, and it never returns something the
 * engine cannot evaluate: an unknown field is dropped, an operator that does
 * not belong to its field is dropped, a broken document degrades to "no
 * filter". A page render must not 500 because someone edited a query string.
 */

import { z } from "zod";
import {
  DEFAULT_SORT,
  EMPTY_FILTER_SET,
  FIELD_LABELS,
  FILTER_FIELDS,
  FILTER_OPERATORS,
  OPERATOR_LABELS,
  SORT_FIELDS,
  labelForField,
  operatorsForField,
  type CustomFieldSpec,
  type FilterCondition,
  type FilterField,
  type FilterSet,
  type SortField,
  type SortSpec,
} from "./filters";
import { COLUMN_KEYS, DEFAULT_COLUMNS, REQUIRED_COLUMN } from "./columns";

/**
 * A filter set is a tool, not a query language. Twenty-five conditions is far
 * past the point of usefulness and well short of anything that could be used to
 * make the evaluator do expensive work on every row.
 */
export const MAX_CONDITIONS = 25;
const MAX_VALUES = 50;

export const conditionSchema = z.object({
  // A built-in field name, or `cf:<key>` for an Owner-defined one (P5/1).
  // Coherence against the workspace's actual definitions is checked in
  // `conditionIsCoherent`, which needs them passed in; the schema only bounds
  // the shape so a hostile string cannot become a giant key.
  field: z.union([z.enum(FILTER_FIELDS), z.string().regex(/^cf:[a-z][a-z0-9_]{0,39}$/)]),
  operator: z.enum(FILTER_OPERATORS),
  value: z.union([z.string(), z.number(), z.null()]).optional(),
  values: z.array(z.string()).max(MAX_VALUES).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

/**
 * Strict validation, used where a caller must be TOLD its input is wrong —
 * saving a view. The lenient `parseFilterSet` below is for rendering, where
 * dropping a bad condition beats refusing to draw the page.
 */
export const filterSetSchema = z.object({
  match: z.enum(["all", "any"]),
  conditions: z.array(conditionSchema).max(MAX_CONDITIONS),
});

export const sortSchema = z.object({
  field: z.enum(SORT_FIELDS),
  direction: z.enum(["asc", "desc"]),
});

/**
 * An operator has to belong to the field, or the condition means nothing.
 *
 * When the caller has not supplied the workspace's custom-field definitions,
 * a `cf:` condition is accepted on shape alone — the evaluator treats an
 * unresolvable custom field as inert, so the worst case is a condition that
 * filters nothing rather than a page that refuses to render.
 */
function conditionIsCoherent(c: FilterCondition, customFields?: readonly CustomFieldSpec[]): boolean {
  if (typeof c.field === "string" && c.field.startsWith("cf:") && !customFields) return true;
  const allowed = operatorsForField(c.field, customFields);
  return Array.isArray(allowed) && allowed.includes(c.operator);
}

/**
 * Parse a filter set from a URL parameter or from a JSON column.
 *
 * Accepts a string (URL) or an already-parsed object (Prisma hands JSONB back
 * decoded), so callers do not have to remember which side they are on.
 */
export function parseFilterSet(
  raw: string | Record<string, unknown> | null | undefined,
  customFields?: readonly CustomFieldSpec[],
): FilterSet {
  if (raw === null || raw === undefined || raw === "") return EMPTY_FILTER_SET;

  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return EMPTY_FILTER_SET;
    }
  }

  if (typeof candidate !== "object" || candidate === null) return EMPTY_FILTER_SET;

  const source = candidate as { match?: unknown; conditions?: unknown };
  const match = source.match === "any" ? "any" : "all";
  if (!Array.isArray(source.conditions)) return { match, conditions: [] };

  const conditions: FilterCondition[] = [];
  for (const entry of source.conditions) {
    if (conditions.length >= MAX_CONDITIONS) break;
    const parsed = conditionSchema.safeParse(entry);
    if (!parsed.success) continue;
    const condition = parsed.data as FilterCondition;
    if (!conditionIsCoherent(condition, customFields)) continue;
    conditions.push(condition);
  }
  return { match, conditions };
}

/** Undefined when there is nothing to say, so unfiltered URLs stay clean. */
export function serializeFilterSet(set: FilterSet): string | undefined {
  if (!set || set.conditions.length === 0) return undefined;
  return JSON.stringify(set);
}

export function parseSort(raw: string | null | undefined): SortSpec {
  if (!raw) return DEFAULT_SORT;
  const [field, direction] = raw.split(":");
  if (!field || !(SORT_FIELDS as readonly string[]).includes(field)) return DEFAULT_SORT;
  return {
    field: field as SortField,
    direction: direction === "asc" ? "asc" : "desc",
  };
}

export function serializeSort(sort: SortSpec): string {
  return `${sort.field}:${sort.direction}`;
}

/**
 * Column selection. Unknown keys are dropped (a view saved before a column was
 * renamed still opens), the contact column is forced back in (every row needs
 * something that identifies and opens it), and a selection with nothing
 * recognisable left falls back to the defaults rather than to an empty table.
 */
export function parseColumns(
  raw: string | string[] | null | undefined,
  extraKeys: readonly string[] = [],
): string[] {
  if (raw === null || raw === undefined || raw === "") return [...DEFAULT_COLUMNS];
  const requested = Array.isArray(raw) ? raw : raw.split(",");
  const allowed = new Set<string>([...COLUMN_KEYS, ...extraKeys]);

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of requested) {
    const trimmed = String(key).trim();
    if (!allowed.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    keys.push(trimmed);
  }

  if (keys.length === 0) return [...DEFAULT_COLUMNS];
  if (!seen.has(REQUIRED_COLUMN)) keys.unshift(REQUIRED_COLUMN);
  return keys;
}

export function serializeColumns(keys: string[]): string {
  return keys.join(",");
}

// ---- human-readable conditions -------------------------------------------

/** "RESEARCHED" reads as "researched" in a chip; the UI is lowercase anyway. */
function humanValue(v: unknown): string {
  return String(v).toLowerCase().replace(/_/g, " ");
}

/**
 * What the chip above the table says. Built here rather than in the component
 * so the same wording can be reused by the bulk-action confirmation, which has
 * to tell the user exactly what set it is about to act on.
 */
export function describeCondition(
  c: FilterCondition,
  customFields?: ReadonlyArray<CustomFieldSpec & { label?: string }>,
): string {
  const field = labelForField(String(c.field), customFields);
  const operator = OPERATOR_LABELS[c.operator] ?? c.operator;

  switch (c.operator) {
    case "is_set":
    case "is_not_set":
    case "is_true":
    case "is_false":
      return `${field} ${operator}`;
    case "between": {
      const min = c.min ?? "…";
      const max = c.max ?? "…";
      return `${field} ${operator} ${min} and ${max}`;
    }
    case "is_any_of":
    case "has_any_of":
    case "has_all_of":
    case "has_none_of": {
      const list = (c.values ?? []).map(humanValue).join(", ");
      return `${field} ${operator} ${list}`;
    }
    default:
      return `${field} ${operator} ${humanValue(c.value ?? "")}`.trim();
  }
}

/** All the chips, for a one-line summary of the active filter. */
export function describeFilterSet(
  set: FilterSet,
  customFields?: ReadonlyArray<CustomFieldSpec & { label?: string }>,
): string {
  if (set.conditions.length === 0) return "No filter";
  const joiner = set.match === "any" ? " or " : " and ";
  return set.conditions.map((c) => describeCondition(c, customFields)).join(joiner);
}
