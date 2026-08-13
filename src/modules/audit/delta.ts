/**
 * Re-audit deltas (P2/5).
 *
 * The second audit of a site is worth more than the first, because a change is
 * a reason to call. Two changes matter and they mean opposite things:
 *
 *   - it got WORSE → something broke, and a site that just started failing is
 *     a business with a problem they may not know about yet;
 *   - it got BETTER → someone else is working on it. That is a competitive
 *     signal, not a happy one, and it is time-critical.
 *
 * Pure over two stored audits. Nothing here decides to contact anyone; it
 * decides what changed.
 */
import type { AuditCheck } from "./types";
import { scoreByCategory, type AuditCategory } from "./categories";

export type DeltaSignificance = "worse" | "better" | "stable";

export interface CategoryDelta {
  category: AuditCategory;
  from: number | null;
  to: number | null;
  /** to - from, on the opportunity scale where higher is a weaker site. */
  delta: number | null;
}

export interface AuditDelta {
  /** The audit this one is compared against. */
  previousAuditId: string;
  previousAt: string;
  scoreFrom: number;
  scoreTo: number;
  /** Positive means the site got WORSE (opportunity score went up). */
  scoreDelta: number;
  categories: CategoryDelta[];
  /** Checks that pass now and did not before. */
  resolved: string[];
  /** Checks that fail now and did not before. */
  broken: string[];
  significance: DeltaSignificance;
}

/**
 * How much has to move before we call it a change.
 *
 * Audit scores wobble a little between runs — a PageSpeed number is a
 * measurement, not a constant. Ten points overall, or fifteen inside one
 * category, is past the noise.
 */
export const SIGNIFICANT_SCORE_DELTA = 10;
export const SIGNIFICANT_CATEGORY_DELTA = 15;

function checkMap(checks: AuditCheck[]): Map<string, boolean> {
  return new Map(checks.map((c) => [c.key, c.pass]));
}

export function computeDelta(
  previous: { id: string; createdAt: Date; score: number; checks: AuditCheck[] },
  current: { score: number; checks: AuditCheck[] },
): AuditDelta {
  const beforeScores = scoreByCategory(previous.checks);
  const afterScores = scoreByCategory(current.checks);

  const categories: CategoryDelta[] = afterScores.map((after) => {
    const before = beforeScores.find((b) => b.category === after.category);
    const from = before?.subscore ?? null;
    const to = after.subscore;
    return {
      category: after.category,
      from,
      to,
      delta: from === null || to === null ? null : to - from,
    };
  });

  const before = checkMap(previous.checks);
  const after = checkMap(current.checks);
  const resolved: string[] = [];
  const broken: string[] = [];
  for (const [key, passes] of after) {
    const was = before.get(key);
    // A check that did not run before tells us nothing about a change.
    if (was === undefined) continue;
    if (passes && !was) resolved.push(key);
    if (!passes && was) broken.push(key);
  }

  const scoreDelta = current.score - previous.score;
  const worstCategory = Math.max(
    0,
    ...categories.map((c) => c.delta ?? 0),
  );
  const bestCategory = Math.min(0, ...categories.map((c) => c.delta ?? 0));

  let significance: DeltaSignificance = "stable";
  if (scoreDelta >= SIGNIFICANT_SCORE_DELTA || worstCategory >= SIGNIFICANT_CATEGORY_DELTA) {
    significance = "worse";
  } else if (
    scoreDelta <= -SIGNIFICANT_SCORE_DELTA ||
    bestCategory <= -SIGNIFICANT_CATEGORY_DELTA
  ) {
    significance = "better";
  }

  return {
    previousAuditId: previous.id,
    previousAt: previous.createdAt.toISOString(),
    scoreFrom: previous.score,
    scoreTo: current.score,
    scoreDelta,
    categories,
    resolved,
    broken,
    significance,
  };
}

/** The signal a significant change produces, in the operator's language. */
export interface DeltaSignal {
  type: "audit_worsened" | "audit_improved";
  /** Shown on the lead timeline and in the suggested task. */
  headlineHu: string;
  suggestedTaskHu: string;
  /** Joins the lead's trigger signals. */
  flag: string;
}

export function signalFor(delta: AuditDelta, siteLabel: string): DeltaSignal | null {
  if (delta.significance === "stable") return null;

  if (delta.significance === "worse") {
    const detail = delta.broken.length > 0 ? ` (${delta.broken.length} új hiba)` : "";
    return {
      type: "audit_worsened",
      headlineHu: `Romlott az oldaluk: ${delta.scoreFrom} → ${delta.scoreTo}${detail} — ${siteLabel}`,
      suggestedTaskHu: "Romlott az oldaluk — időszerű megkeresés",
      flag: "site got worse",
    };
  }

  // An improvement is a warning, not a celebration: somebody else may have
  // just been hired.
  const detail = delta.resolved.length > 0 ? ` (${delta.resolved.length} javítás)` : "";
  return {
    type: "audit_improved",
    headlineHu: `Javult az oldaluk: ${delta.scoreFrom} → ${delta.scoreTo}${detail} — ${siteLabel}`,
    suggestedTaskHu: "Javult az oldaluk — lehet, hogy szerződtek valakivel",
    flag: "site improved",
  };
}
