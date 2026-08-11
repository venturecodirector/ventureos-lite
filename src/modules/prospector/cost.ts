/**
 * Places API cost estimate (spec §4.3 — a pre-run estimate is shown before
 * executing). Deterministic and cheap; Claude is never used to find businesses.
 */
export const TEXT_SEARCH_COST_USD = 0.032; // per Text Search request (per page)
export const PLACE_DETAILS_COST_USD = 0.017; // per Place Details lookup
export const RESULTS_PER_PAGE = 20;

export function estimateProspectCostUsd(opts: {
  expectedResults: number;
  withDetails?: boolean;
}): number {
  const pages = Math.max(1, Math.ceil(opts.expectedResults / RESULTS_PER_PAGE));
  let cost = pages * TEXT_SEARCH_COST_USD;
  if (opts.withDetails) cost += opts.expectedResults * PLACE_DETAILS_COST_USD;
  return cost;
}
