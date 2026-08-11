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
