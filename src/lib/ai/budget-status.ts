import { getWorkspaceClient, prismaUnsafe } from "../db";

/**
 * Today's Claude spend against the workspace's daily cap (CLAUDE.md hard rule
 * #3, spec §6.7) — the numbers behind the budget meter in the shell.
 *
 * Same source of truth the enforcement path uses (`callClaude` → `spentTodayUsd`
 * / `capUsd`), so what the meter shows and what actually blocks a call can
 * never disagree. The day boundary is UTC, matching the reset the
 * BudgetExceededError message promises.
 */
export interface BudgetStatus {
  spentUsd: number;
  capUsd: number;
  /** 0–100, clamped. 100 means the cap is reached and AI calls are blocked. */
  pct: number;
  exhausted: boolean;
  /** Cheap formatted labels so the shell does no number formatting. */
  spentLabel: string;
  capLabel: string;
}

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Pure shaping, so the percentage/label logic is testable without a database. */
export function buildBudgetStatus(spentUsd: number, capUsd: number): BudgetStatus {
  const safeSpent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  const safeCap = Number.isFinite(capUsd) && capUsd > 0 ? capUsd : 0;
  const pct = safeCap === 0 ? 100 : Math.min(100, Math.round((safeSpent / safeCap) * 100));
  return {
    spentUsd: safeSpent,
    capUsd: safeCap,
    pct,
    exhausted: safeSpent >= safeCap,
    // Sub-cent spend still deserves to be visible, hence 2 decimals both sides.
    spentLabel: `$${safeSpent.toFixed(2)}`,
    capLabel: `$${safeCap.toFixed(2)}`,
  };
}

export async function getBudgetStatus(workspaceId: string): Promise<BudgetStatus> {
  const db = getWorkspaceClient(workspaceId);
  const [agg, ws] = await Promise.all([
    db.claudeUsage.aggregate({
      _sum: { cost: true },
      where: { at: { gte: startOfUtcDay() } },
    }),
    prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { claudeBudget: true },
    }),
  ]);
  return buildBudgetStatus(Number(agg._sum.cost ?? 0), Number(ws?.claudeBudget ?? 0));
}
