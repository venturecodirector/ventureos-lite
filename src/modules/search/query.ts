/**
 * Global search query shaping (spec §4.1 top bar). Pure — no I/O — so the
 * normalisation and ranking rules are testable without a database.
 */

/** Below this, a query matches too much to be useful. */
export const MIN_QUERY_LENGTH = 2;
export const MAX_RESULTS_PER_KIND = 5;
export const MAX_RESULTS = 12;

export type SearchKind = "lead" | "company" | "document";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  /** Primary line — the thing the user recognises. */
  title: string;
  /** Secondary line: company, domain, tax id, document number… */
  subtitle: string;
  /** Where Enter takes you. */
  href: string;
  /** Higher sorts first. */
  score: number;
}

/** Collapse whitespace and case so "  Kft.  " and "kft." behave the same. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export function isSearchable(raw: string): boolean {
  return normalizeQuery(raw).length >= MIN_QUERY_LENGTH;
}

/** Digits only — used to compare a typed id against a stored one. */
export function taxIdDigits(q: string): string {
  return q.replace(/\D/g, "");
}

/**
 * The 8-digit core of an adószám, for any way a person might type it:
 * "12345678", "12345678-1-42" and "12345678142" all reduce to "12345678".
 *
 * This is what actually goes into the SQL `contains`. A digits-only query
 * cannot match a dashed stored value directly, and the column stores whatever
 * was typed — but the first 8 digits are always present and always identical,
 * so matching on the core finds the row in every form. Returns null when the
 * query is not tax-id-shaped at all.
 */
export function taxIdCore(q: string): string | null {
  const compact = q.replace(/[\s-]/g, "");
  if (!/^\d{8,11}$/.test(compact)) return null;
  return compact.slice(0, 8);
}

/**
 * Rank a hit. Exact and prefix matches beat matches buried mid-string, so
 * typing "ave" surfaces "Aventa" above "Scandinave".
 */
export function rankMatch(field: string | null | undefined, query: string): number {
  if (!field) return 0;
  const f = field.toLowerCase();
  const q = query.toLowerCase();
  const at = f.indexOf(q);
  if (at === -1) return 0;
  if (f === q) return 100;
  if (at === 0) return 60;
  // A match at a word boundary reads as intentional; mid-word is incidental.
  if (/\s|[-_.]/.test(f.charAt(at - 1))) return 40;
  return 20;
}

/** Best rank across several fields. */
export function bestRank(fields: Array<string | null | undefined>, query: string): number {
  return fields.reduce<number>((best, f) => Math.max(best, rankMatch(f, query)), 0);
}

/**
 * Order and trim the combined result set. Leads first on equal score: the BDR
 * is far more often looking for a person than for the company record behind it.
 */
const KIND_TIEBREAK: Record<SearchKind, number> = { lead: 3, company: 2, document: 1 };

export function orderHits(hits: SearchHit[]): SearchHit[] {
  return [...hits]
    .sort(
      (a, b) =>
        b.score - a.score ||
        KIND_TIEBREAK[b.kind] - KIND_TIEBREAK[a.kind] ||
        a.title.localeCompare(b.title),
    )
    .slice(0, MAX_RESULTS);
}
