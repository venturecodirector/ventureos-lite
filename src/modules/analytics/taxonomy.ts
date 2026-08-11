/**
 * Win/loss outcome taxonomy + validation (spec §4.20). Pure module — shared by
 * the close dialog (server), the meetings handoff, and the quarterly digest.
 * Closing a Handed-off lead REQUIRES a valid outcome; this is the gate.
 */
export const OUTCOME_RESULTS = ["won", "lost", "postponed"] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export const OUTCOME_REASONS = [
  "price",
  "timing",
  "competitor",
  "no_budget",
  "no_response",
  "other",
] as const;
export type OutcomeReason = (typeof OUTCOME_REASONS)[number];

export const RESULT_LABEL: Record<OutcomeResult, string> = {
  won: "Won",
  lost: "Lost",
  postponed: "Postponed",
};

export const REASON_LABEL: Record<OutcomeReason, string> = {
  price: "Price",
  timing: "Timing",
  competitor: "Competitor",
  no_budget: "No budget",
  no_response: "No response",
  other: "Other",
};

export interface OutcomeInput {
  result: string;
  reason: string;
  value: number | null;
  competitor?: string | null;
  note?: string | null;
}

export interface NormalizedOutcome {
  result: OutcomeResult;
  reason: OutcomeReason;
  value: number;
  competitor: string | null;
  note: string | null;
}

export function validateOutcome(
  i: OutcomeInput,
): { ok: true; value: NormalizedOutcome } | { ok: false; error: string } {
  if (!OUTCOME_RESULTS.includes(i.result as OutcomeResult)) {
    return { ok: false, error: "Choose an outcome: won, lost, or postponed." };
  }
  if (!OUTCOME_REASONS.includes(i.reason as OutcomeReason)) {
    return { ok: false, error: "Pick a reason from the taxonomy." };
  }
  const note = (i.note ?? "").trim();
  if (i.reason === "other" && note === "") {
    return { ok: false, error: "A note is required when the reason is Other." };
  }
  if (i.value == null || !Number.isInteger(i.value) || i.value < 0) {
    return { ok: false, error: "Deal value must be a whole, non-negative number of HUF." };
  }
  const competitor = (i.competitor ?? "").trim();
  return {
    ok: true,
    value: {
      result: i.result as OutcomeResult,
      reason: i.reason as OutcomeReason,
      value: i.value,
      competitor: competitor || null,
      note: note || null,
    },
  };
}

export type ScoreBand = "no_audit" | "0-49" | "50-69" | "70-84" | "85-100";

export function scoreBand(score: number | null | undefined): ScoreBand {
  if (score == null) return "no_audit";
  if (score < 50) return "0-49";
  if (score < 70) return "50-69";
  if (score < 85) return "70-84";
  return "85-100";
}
