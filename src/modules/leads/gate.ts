import type { Stage } from "@prisma/client";

/**
 * Score gate (CLAUDE.md hard rule #5, spec §4.5): a lead scoring below the
 * workspace threshold cannot enter the Contacted stage. Enforced in the API
 * layer (server actions), not just the UI — this is the pure predicate they call.
 */
export class ScoreGateError extends Error {
  readonly leadId?: string;
  readonly score: number | null;
  readonly threshold: number;

  constructor(a: { leadId?: string; score: number | null; threshold: number }) {
    super(
      `Lead${a.leadId ? ` ${a.leadId}` : ""} cannot enter Contacted: ICP score ` +
        `${a.score ?? "—"} is below the gate threshold of ${a.threshold}.`,
    );
    this.name = "ScoreGateError";
    this.leadId = a.leadId;
    this.score = a.score;
    this.threshold = a.threshold;
    Object.setPrototypeOf(this, ScoreGateError.prototype);
  }
}

export function assertCanEnterStage(params: {
  toStage: Stage;
  score: number | null;
  threshold: number;
  leadId?: string;
}): void {
  if (params.toStage !== "CONTACTED") return;
  if (params.score === null || params.score < params.threshold) {
    throw new ScoreGateError({
      leadId: params.leadId,
      score: params.score,
      threshold: params.threshold,
    });
  }
}
