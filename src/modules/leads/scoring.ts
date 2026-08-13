/**
 * ICP scoring (spec §4.5). Five 1-point criteria; total 0–5. Claude proposes
 * the breakdown during a research run; the score is the deterministic sum
 * (never AI-computed), and every override is audit-logged.
 */
export const ICP_CRITERIA = [
  "segment_fit",
  "trigger_signal",
  "decision_maker",
  "active_profile",
  "personal_hook",
] as const;

export type IcpCriterion = (typeof ICP_CRITERIA)[number];

export type IcpBreakdown = Record<IcpCriterion, 0 | 1>;

export const MAX_ICP_SCORE = ICP_CRITERIA.length; // 5

export function computeIcpScore(breakdown: IcpBreakdown): number {
  return ICP_CRITERIA.reduce((sum, key) => sum + (breakdown[key] ? 1 : 0), 0);
}

/** Default gate threshold when a workspace hasn't configured its own. */
export const DEFAULT_GATE_THRESHOLD = 3;

/** Read the workspace's configured gate threshold from its icpConfig JSON. */
export function gateThresholdFromConfig(icpConfig: unknown): number {
  if (
    icpConfig &&
    typeof icpConfig === "object" &&
    "gateThreshold" in icpConfig &&
    typeof (icpConfig as { gateThreshold: unknown }).gateThreshold === "number"
  ) {
    return (icpConfig as { gateThreshold: number }).gateThreshold;
  }
  return DEFAULT_GATE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// unknown handling (P1/1d)
// ---------------------------------------------------------------------------

/**
 * A criterion the model could not judge because the input said nothing about
 * it. Distinct from a judged 0.
 *
 * Silently folding "no data" into 0 is the bug this fixes: a lead scored 2/5
 * because half the profile was missing looks identical to a lead genuinely
 * assessed as weak, and the score gate then blocks it with no explanation.
 * Unknowns still contribute 0 to the total — the gate must stay conservative —
 * but they are recorded and shown, so the operator can see the score is
 * incomplete rather than damning and go find the missing input.
 */
export type IcpValue = 0 | 1 | "unknown";
export type IcpBreakdownWithUnknown = Record<IcpCriterion, IcpValue>;

export interface IcpAssessment {
  /** Deterministic sum; unknown counts as 0. */
  score: number;
  /** Criteria that were judged either way. */
  known: IcpCriterion[];
  /** Criteria with no evidence in the input. */
  unknown: IcpCriterion[];
  /** The best this lead could reach if every unknown turned out positive. */
  potentialScore: number;
  /** True when anything is missing — drives the "incomplete" hint in the UI. */
  incomplete: boolean;
}

export function assessIcp(breakdown: Partial<IcpBreakdownWithUnknown>): IcpAssessment {
  const known: IcpCriterion[] = [];
  const unknown: IcpCriterion[] = [];
  let score = 0;

  for (const key of ICP_CRITERIA) {
    const raw = breakdown?.[key];
    // Anything that is not an explicit 0 or 1 is missing data, including a
    // key the model omitted entirely.
    if (raw === 0 || raw === 1) {
      known.push(key);
      score += raw;
    } else {
      unknown.push(key);
    }
  }

  return {
    score,
    known,
    unknown,
    potentialScore: score + unknown.length,
    incomplete: unknown.length > 0,
  };
}

/** Human-readable reason a score is incomplete, for the lead card. */
export const CRITERION_LABELS: Record<IcpCriterion, string> = {
  segment_fit: "Segment fit",
  trigger_signal: "Trigger signal",
  decision_maker: "Decision-maker",
  active_profile: "Active profile",
  personal_hook: "Personal hook",
};
