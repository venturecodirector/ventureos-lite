import { AUDIT_CATEGORIES, type AuditCategory } from "@/modules/audit/categories";

/**
 * Aggregating a batch of audits into a publishable report (playbook-v4 P12/2a).
 *
 * ── EVERYTHING HERE IS A NUMBER ────────────────────────────────────────────
 *
 * No company name, no domain, no URL, not even a "worst performer". A report
 * that identifies the businesses it measured is a list, and publishing one
 * would burn the goodwill the whole exercise exists to build. The types below
 * make that structural rather than a rule somebody has to remember: there is
 * nowhere in `SectorStats` to put a name.
 *
 * Pure, so the arithmetic is testable without a browser or a database.
 */

export interface AuditInput {
  score: number;
  /** Per-category subscores, 0–100, where HIGH means weak. Null = not measured. */
  categories: Partial<Record<AuditCategory, number | null>>;
  /** Individual check results, keyed by check id. */
  checks: Record<string, boolean | null>;
  /** Largest contentful paint in milliseconds, when measured. */
  loadMs: number | null;
}

export interface SectorStats {
  audited: number;
  /** Businesses the search found, including those with no site to measure. */
  found: number;
  scoreMedian: number;
  /** How the scores fall, in bands a reader can picture. */
  scoreBands: { weak: number; middling: number; strong: number };
  loadMsMedian: number | null;
  /** Share (0–1) failing each named check, with the count it came from. */
  failing: Array<{ key: string; label: string; share: number; of: number }>;
  /** Median subscore per category, weakest first. */
  categories: Array<{ category: AuditCategory; median: number }>;
}

/** The checks worth putting in front of a business owner, in plain Hungarian. */
export const HEADLINE_CHECKS: Array<{ key: string; label: string }> = [
  { key: "isHttps", label: "nincs biztonságos (HTTPS) kapcsolat" },
  { key: "hasViewport", label: "nincs mobilra tervezett elrendezés" },
  { key: "impresszum", label: "nincs impresszum" },
  { key: "privacyPolicy", label: "nincs adatkezelési tájékoztató" },
  { key: "dmarc", label: "nincs DMARC (levélhamisítás elleni védelem)" },
  { key: "spf", label: "nincs SPF" },
  { key: "hasPhone", label: "nincs kattintható telefonszám" },
  { key: "hasSitemap", label: "nincs sitemap" },
];

export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/**
 * The minimum sample worth publishing.
 *
 * Below this a "median" is one or two businesses wearing a statistic's clothes,
 * and a sector report built on it would be a claim we could not defend if
 * somebody asked how many sites were behind the number.
 */
export const MIN_PUBLISHABLE = 12;

export function aggregate(audits: AuditInput[], found: number): SectorStats {
  const scores = audits.map((a) => a.score);
  const bands = { weak: 0, middling: 0, strong: 0 };
  for (const s of scores) {
    // The opportunity score runs the other way: HIGH means a weak site.
    if (s >= 60) bands.weak += 1;
    else if (s >= 30) bands.middling += 1;
    else bands.strong += 1;
  }

  const failing = HEADLINE_CHECKS.map(({ key, label }) => {
    const measured = audits.filter((a) => typeof a.checks[key] === "boolean");
    const failed = measured.filter((a) => a.checks[key] === false).length;
    return {
      key,
      label,
      share: measured.length > 0 ? failed / measured.length : 0,
      of: measured.length,
    };
  })
    // Only what was actually measured on a meaningful number of sites.
    .filter((f) => f.of > 0)
    .sort((a, b) => b.share - a.share);

  const categories = AUDIT_CATEGORIES.map((category) => {
    const values = audits
      .map((a) => a.categories[category])
      .filter((v): v is number => typeof v === "number");
    return { category, median: median(values) ?? 0 };
  })
    .filter((c) => c.median > 0)
    .sort((a, b) => b.median - a.median);

  return {
    audited: audits.length,
    found,
    scoreMedian: median(scores) ?? 0,
    scoreBands: bands,
    loadMsMedian: median(
      audits.map((a) => a.loadMs).filter((v): v is number => typeof v === "number"),
    ),
    failing,
    categories,
  };
}

/**
 * Everything a reader might use to identify one business, checked on the way
 * out rather than trusted on the way in.
 *
 * Used by the anonymity test on the rendered artifact and by the publish
 * action — a report that trips this is refused rather than warned about.
 */
export function findIdentifiers(text: string): string[] {
  const hits = new Set<string>();
  // A domain, an email, or a URL is the only way a company gets named here.
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)) hits.add(m[0]);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi)) hits.add(m[0]);
  for (const m of text.matchAll(
    /\b(?!ventureco\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:hu|com|net|org|eu|io|agency|group)\b/gi,
  )) {
    hits.add(m[0]);
  }
  return [...hits];
}
