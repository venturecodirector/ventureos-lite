/**
 * ICP score gate (CLAUDE.md hard rule #5 / spec §4.5).
 * Leads scoring below the threshold cannot enter the Contacted stage.
 * Enforced in the API layer; this is the pure predicate it calls.
 */
export const SCORE_GATE_THRESHOLD = 3;

export function canEnterContacted(
  score: number,
  threshold: number = SCORE_GATE_THRESHOLD,
): boolean {
  return score >= threshold;
}
