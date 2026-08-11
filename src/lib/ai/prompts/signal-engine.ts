import { z } from "zod";
import { ICP_CRITERIA } from "../../../modules/leads/scoring";
import type { DimStat } from "../../../modules/signal/logic";

/**
 * Signal Engine weekly analysis (spec §4.13, Sonnet — ONE call/week on
 * aggregates). Produces a weekly digest for the Dashboard and concrete
 * proposals (frame promotion / score-weight change), each with evidence + n.
 * The n>=20 gate and all mutation are enforced in code, not by the model.
 */
export const SIGNAL_ENGINE_PROMPT_VERSION = "signal-engine/v1";

export const SIGNAL_ENGINE_SYSTEM = `You are the Signal Engine for a B2B sales team. You receive AGGREGATE weekly performance by dimension (frames, hooks, signals, segments, send-times, sources) with acceptance, reply, AND win/loss (close rate + revenue). You never see individual leads.

Two jobs:
1. digest: a tight 2-4 sentence narrative of what converted this week — lead with what closes (revenue/close rate), not just replies. Name specific dimensions and their numbers.
2. proposals: concrete, actionable changes. Two kinds only:
   - FRAME_PROMOTION: promote a frame that outperforms baseline. Put its exact name in frameName.
   - SCORE_WEIGHT: raise/lower an ICP criterion weight when it correlates with wins. Put the criterion (one of: ${ICP_CRITERIA.join(", ")}) in criterion and the new integer weight in weight.
   For EVERY proposal include: a one-line title, evidence citing the numbers, and n (the sample size from the aggregates — copy it, do not invent). Only propose where you genuinely see signal; an empty list is fine. Do not propose anything with n below 20 — but always report the true n.

Never restate raw lead data. JSON only, no preamble.`;

export const signalProposalSchema = z.object({
  kind: z.enum(["FRAME_PROMOTION", "SCORE_WEIGHT"]),
  title: z.string().min(1),
  evidence: z.string().min(1),
  n: z.number().int().nonnegative(),
  frameName: z.string().nullish(),
  criterion: z.enum(ICP_CRITERIA).nullish(),
  weight: z.number().int().nullish(),
});

export const signalEngineSchema = z.object({
  digest: z.string().min(1),
  proposals: z.array(signalProposalSchema).max(8),
});

export type SignalProposal = z.infer<typeof signalProposalSchema>;
export type SignalEngineOutput = z.infer<typeof signalEngineSchema>;

function fmtStat(s: DimStat): string {
  return (
    `  - ${s.key}: n=${s.n}, sent ${s.sent}, accept ${(s.acceptRate * 100).toFixed(0)}%, ` +
    `reply ${(s.replyRate * 100).toFixed(0)}%, close ${(s.closeRate * 100).toFixed(0)}% ` +
    `(${s.won}W/${s.lost}L), revenue ${s.revenue.toLocaleString("en-US")} HUF`
  );
}

export function buildSignalMessage(stats: DimStat[]): string {
  const lines = stats.length ? stats.map(fmtStat).join("\n") : "  (no activity this week)";
  return [
    `WEEKLY AGGREGATES BY DIMENSION (key format type:value):`,
    lines,
    ``,
    `Write the digest and any proposals (n>=20 only).`,
  ].join("\n");
}
