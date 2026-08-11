/**
 * Per-workspace daily USD cap (CLAUDE.md hard rule #3, spec §6.7). Once today's
 * spend reaches the cap, further AI calls are blocked with a typed error;
 * deterministic features keep working (acceptance criterion #9).
 */
export class BudgetExceededError extends Error {
  readonly workspaceId: string;
  readonly spentUsd: number;
  readonly capUsd: number;

  constructor(a: { workspaceId: string; spentUsd: number; capUsd: number }) {
    super(
      `Claude daily budget reached for workspace ${a.workspaceId}: ` +
        `$${a.spentUsd.toFixed(4)} spent of $${a.capUsd.toFixed(2)} cap. ` +
        `AI calls resume tomorrow.`,
    );
    this.name = "BudgetExceededError";
    this.workspaceId = a.workspaceId;
    this.spentUsd = a.spentUsd;
    this.capUsd = a.capUsd;
    Object.setPrototypeOf(this, BudgetExceededError.prototype);
  }
}

/** Gate before an AI call. Throws once spend has reached the cap. */
export function assertWithinBudget(a: {
  workspaceId: string;
  spentUsd: number;
  capUsd: number;
}): void {
  if (a.spentUsd >= a.capUsd) {
    throw new BudgetExceededError(a);
  }
}
