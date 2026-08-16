/**
 * Deal arithmetic (playbook-v2 P4/b, P4/c). Pure — no Prisma, no clock of its
 * own — so a forecast figure can be reproduced from its inputs in a test.
 */

export interface DealLike {
  id: string;
  value: number;
  /** Per-deal override, or null to take the stage's default. */
  probability: number | null;
  stageProbability: number;
  expectedCloseAt: Date | null;
  status: "OPEN" | "WON" | "LOST";
}

/** 0-100, clamped. A stage default only applies while the deal has no opinion. */
export function effectiveProbability(deal: {
  probability: number | null;
  stageProbability: number;
  status?: "OPEN" | "WON" | "LOST";
}): number {
  // A closed deal is not a forecast any more — it is a fact worth 100 or 0.
  if (deal.status === "WON") return 100;
  if (deal.status === "LOST") return 0;
  const raw = deal.probability ?? deal.stageProbability;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** value × probability, in whole forints. */
export function weightedValue(deal: DealLike): number {
  return Math.round((deal.value * effectiveProbability(deal)) / 100);
}

/** Whole days a card has sat where it is. */
export function daysInStage(stageEnteredAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - stageEnteredAt.getTime()) / 86_400_000));
}

/**
 * Is this card rotting?
 *
 * Only open deals rot. A won deal that has sat in Won for a year has not gone
 * stale, it has been paid — flagging it would train people to ignore the flag.
 */
export function isRotting(input: {
  status: "OPEN" | "WON" | "LOST";
  stageEnteredAt: Date;
  rottingDays: number | null;
  now: Date;
}): boolean {
  if (input.status !== "OPEN") return false;
  if (input.rottingDays === null || input.rottingDays <= 0) return false;
  return daysInStage(input.stageEnteredAt, input.now) > input.rottingDays;
}

// ---- forecast --------------------------------------------------------------

/** `YYYY-MM` in local time — the same convention the revenue module uses. */
export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export interface ForecastRow {
  /** `YYYY-MM`, or "unscheduled" for deals with no expected close date. */
  month: string;
  count: number;
  /** Raw sum of `value`. */
  total: number;
  /** Σ value × probability. */
  weighted: number;
  /** Weighted value of deals at or above the commit threshold. */
  commit: number;
  /** Weighted value of everything below it. */
  upside: number;
}

export const UNSCHEDULED = "unscheduled";

/** Default split point between "this is coming in" and "this might". */
export const DEFAULT_COMMIT_THRESHOLD = 70;

export interface ForecastResult {
  rows: ForecastRow[];
  totals: Omit<ForecastRow, "month">;
  commitThreshold: number;
}

/**
 * Weighted forecast by expected-close month.
 *
 * Only OPEN deals are forecast. A won deal is revenue and belongs on the
 * revenue tab; a lost one is nothing. Including either would make the forecast
 * grow every time something closed, which is the opposite of what a forecast
 * is for.
 *
 * Deals with no expected close date are NOT dropped — they land in an
 * `unscheduled` bucket, because silently excluding them is how a pipeline comes
 * to be worth less than it is.
 */
export function buildForecast(
  deals: DealLike[],
  opts?: { commitThreshold?: number; months?: string[] },
): ForecastResult {
  const commitThreshold = opts?.commitThreshold ?? DEFAULT_COMMIT_THRESHOLD;
  const byMonth = new Map<string, ForecastRow>();

  const ensure = (month: string): ForecastRow => {
    const existing = byMonth.get(month);
    if (existing) return existing;
    const row: ForecastRow = { month, count: 0, total: 0, weighted: 0, commit: 0, upside: 0 };
    byMonth.set(month, row);
    return row;
  };

  for (const month of opts?.months ?? []) ensure(month);

  for (const deal of deals) {
    if (deal.status !== "OPEN") continue;
    const month = deal.expectedCloseAt ? monthKeyOf(deal.expectedCloseAt) : UNSCHEDULED;
    const row = ensure(month);
    const p = effectiveProbability(deal);
    const w = weightedValue(deal);
    row.count += 1;
    row.total += deal.value;
    row.weighted += w;
    if (p >= commitThreshold) row.commit += w;
    else row.upside += w;
  }

  // Chronological, with the unscheduled bucket last — it has no place on a
  // timeline but must still be visible.
  const rows = [...byMonth.values()].sort((a, b) => {
    if (a.month === UNSCHEDULED) return 1;
    if (b.month === UNSCHEDULED) return -1;
    return a.month.localeCompare(b.month);
  });

  const totals = rows.reduce(
    (acc, r) => ({
      count: acc.count + r.count,
      total: acc.total + r.total,
      weighted: acc.weighted + r.weighted,
      commit: acc.commit + r.commit,
      upside: acc.upside + r.upside,
    }),
    { count: 0, total: 0, weighted: 0, commit: 0, upside: 0 },
  );

  return { rows, totals, commitThreshold };
}

/** The next `count` month keys starting from `from`, inclusive. */
export function monthRange(from: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(monthKeyOf(new Date(from.getFullYear(), from.getMonth() + i, 1)));
  }
  return out;
}

// ---- win/loss calibration (P4/c) ------------------------------------------

export interface StageWinLoss {
  stageId: string;
  stageName: string;
  pipelineName: string;
  currentProbability: number;
  won: number;
  lost: number;
}

export interface ProbabilityProposal extends StageWinLoss {
  n: number;
  /** Observed win rate as a whole percentage. */
  observed: number;
  suggested: number;
}

/** Below this, the sample says nothing and no proposal is raised. */
export const MIN_CALIBRATION_N = 20;

/**
 * Quarterly recalibration CANDIDATES — proposals only, never an applied change
 * (CLAUDE.md: the Signal Engine proposes, an Owner decides).
 *
 * A stage is only worth revisiting when it has seen at least `MIN_CALIBRATION_N`
 * closed deals AND the observed rate differs from the configured one by more
 * than a rounding wobble. Proposing a 1-point move twenty times a year is how
 * an approval queue gets ignored.
 */
export function probabilityProposals(
  stages: StageWinLoss[],
  opts?: { minN?: number; minDelta?: number },
): ProbabilityProposal[] {
  const minN = opts?.minN ?? MIN_CALIBRATION_N;
  const minDelta = opts?.minDelta ?? 10;
  const out: ProbabilityProposal[] = [];
  for (const s of stages) {
    const n = s.won + s.lost;
    if (n < minN) continue;
    const observed = Math.round((s.won / n) * 100);
    if (Math.abs(observed - s.currentProbability) < minDelta) continue;
    out.push({ ...s, n, observed, suggested: observed });
  }
  return out.sort((a, b) => b.n - a.n);
}
