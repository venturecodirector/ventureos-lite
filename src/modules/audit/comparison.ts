/**
 * Competitor side-by-side (P2/3).
 *
 * A score on its own invites "compared to what?". Two local competitors answer
 * it, and the answer is usually the most persuasive page in the report — not
 * because we say the site is weak, but because the reader can see where it
 * stands among businesses they already think of as their peers.
 *
 * Two hard rules live here:
 *
 *   1. The public share page NEVER names a third party. A prospect's own
 *      report is not a place to publish someone else's audit. Publicly the
 *      comparison collapses to "két helyi versenytárs átlaga", and a test
 *      asserts no competitor name or domain survives that path.
 *   2. Nothing here is scored by AI. The rows are the same deterministic
 *      checks the audit already produced, read a second way.
 *
 * Pure over AuditView-shaped inputs so both rules are testable without a
 * browser, a network or a database.
 */
import type { AuditCheck } from "./types";
import { scoreByCategory } from "./categories";

/** One participant: the prospect, or a competitor. */
export interface ComparisonSubject {
  auditId: string;
  url: string;
  /** Company name when we know it; only ever used internally. */
  name: string | null;
  score: number;
  checks: AuditCheck[];
}

export type ComparisonDirection = "better" | "worse" | "same";

export interface ComparisonRow {
  key: string;
  /** Internal label and the Hungarian one a prospect reads. */
  en: string;
  hu: string;
  /** Prospect's value, then one per competitor, in the order given. */
  values: Array<number | null>;
  /** Prospect vs. the competitors' average. */
  direction: ComparisonDirection;
  /** One line of plain Hungarian, facts only. */
  takeawayHu: string;
  /**
   * True when a lower number is the better outcome. Every audit subscore is an
   * opportunity score — high means weak — so this is true for all of them
   * except the ones we invert on the way in.
   */
  lowerIsBetter: boolean;
}

export interface ComparisonTable {
  subjects: ComparisonSubject[];
  rows: ComparisonRow[];
}

/** Percentage of a category's weight that failed, or null when unmeasured. */
function categorySubscore(checks: AuditCheck[], category: string): number | null {
  return scoreByCategory(checks).find((c) => c.category === category)?.subscore ?? null;
}

/** Share of the named checks that passed, 0-100, or null when none ran. */
function passRate(checks: AuditCheck[], keys: string[]): number | null {
  const present = checks.filter((c) => keys.includes(c.key));
  if (present.length === 0) return null;
  return Math.round((present.filter((c) => c.pass).length / present.length) * 100);
}

/**
 * The rows, in the order they read best: the headline, then what a business
 * owner actually recognises.
 */
const ROW_DEFS: Array<{
  key: string;
  en: string;
  hu: string;
  lowerIsBetter: boolean;
  value: (s: ComparisonSubject) => number | null;
}> = [
  {
    key: "overall",
    en: "Overall score",
    hu: "Összesített pontszám",
    lowerIsBetter: true,
    value: (s) => s.score,
  },
  {
    key: "speed",
    en: "Speed",
    hu: "Sebesség",
    lowerIsBetter: true,
    value: (s) => categorySubscore(s.checks, "performance"),
  },
  {
    key: "mobile",
    en: "Mobile",
    hu: "Mobilbarát megjelenés",
    lowerIsBetter: false,
    value: (s) => passRate(s.checks, ["viewport"]),
  },
  {
    key: "seo",
    en: "SEO basics",
    hu: "Megtalálhatóság alapjai",
    lowerIsBetter: false,
    value: (s) =>
      passRate(s.checks, ["title", "metaDescription", "h1", "openGraph", "canonical", "sitemap"]),
  },
  {
    key: "legal",
    en: "Legal compliance",
    hu: "Jogi megfelelés",
    lowerIsBetter: false,
    value: (s) => passRate(s.checks, ["impresszum", "privacyPolicy", "aszf", "cookie"]),
  },
];

/** Meaningful gap. Below this the two are called equal rather than ranked. */
const TIE_BAND = 5;

function averageOf(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

function takeaway(
  hu: string,
  mine: number | null,
  theirs: number | null,
  direction: ComparisonDirection,
  competitorCount: number,
): string {
  if (mine === null || theirs === null) return `${hu}: nincs összehasonlítható mérés.`;
  const peers = competitorCount === 1 ? "a versenytárs" : "a versenytársak átlaga";
  if (direction === "same") return `${hu}: gyakorlatilag azonos szinten ${peers}sal.`;
  const diff = Math.abs(Math.round(mine - theirs));
  return direction === "better"
    ? `${hu}: ${diff} ponttal jobb, mint ${peers}.`
    : `${hu}: ${diff} ponttal gyengébb, mint ${peers}.`;
}

/**
 * Build the table. The first subject is the prospect; the rest are competitors.
 */
export function buildComparison(subjects: ComparisonSubject[]): ComparisonTable {
  const [mine, ...others] = subjects;
  const rows: ComparisonRow[] = [];
  if (!mine) return { subjects, rows };

  for (const def of ROW_DEFS) {
    const values = subjects.map(def.value);
    const myValue = values[0] ?? null;
    const theirAverage = averageOf(values.slice(1));

    let direction: ComparisonDirection = "same";
    if (myValue !== null && theirAverage !== null) {
      const delta = myValue - theirAverage;
      if (Math.abs(delta) >= TIE_BAND) {
        // On an opportunity score, lower is the better site.
        direction = def.lowerIsBetter ? (delta < 0 ? "better" : "worse") : delta > 0 ? "better" : "worse";
      }
    }

    rows.push({
      key: def.key,
      en: def.en,
      hu: def.hu,
      values,
      direction,
      lowerIsBetter: def.lowerIsBetter,
      takeawayHu: takeaway(def.hu, myValue, theirAverage, direction, others.length),
    });
  }

  return { subjects, rows };
}

/** What the public share page is allowed to see. */
export interface PublicComparison {
  /** How many competitors went into the average. */
  competitorCount: number;
  rows: Array<{
    hu: string;
    mine: number | null;
    /** The competitors, averaged into one anonymous column. */
    peerAverage: number | null;
    direction: ComparisonDirection;
    takeawayHu: string;
    lowerIsBetter: boolean;
  }>;
}

/**
 * Strip the comparison down to what a prospect may be shown.
 *
 * Names, URLs and per-competitor values are dropped here rather than in the
 * page, because a filter in JSX is one careless edit away from leaking someone
 * else's audit onto a public URL. Everything that leaves this function is a
 * number about the reader plus one anonymous average.
 */
export function anonymizeComparison(table: ComparisonTable): PublicComparison {
  const competitorCount = Math.max(0, table.subjects.length - 1);
  return {
    competitorCount,
    rows: table.rows.map((r) => ({
      hu: r.hu,
      mine: r.values[0] ?? null,
      peerAverage: (() => {
        const avg = averageOf(r.values.slice(1));
        return avg === null ? null : Math.round(avg);
      })(),
      direction: r.direction,
      takeawayHu: r.takeawayHu,
      lowerIsBetter: r.lowerIsBetter,
    })),
  };
}

/** Audit ids stored on a row, whatever shape the JSON turned out to be. */
export function comparisonAuditIds(comparison: unknown): string[] {
  if (!comparison || typeof comparison !== "object") return [];
  const ids = (comparison as { auditIds?: unknown }).auditIds;
  return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string") : [];
}

/** The Hungarian label for the anonymous column. */
export function peerColumnLabelHu(competitorCount: number): string {
  return competitorCount === 1
    ? "Egy helyi versenytárs"
    : `${competitorCount} helyi versenytárs átlaga`;
}
