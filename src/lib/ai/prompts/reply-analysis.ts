import { z } from "zod";

/**
 * Reply analysis (spec §4.7 / §5, Haiku). Runs on each logged inbound reply,
 * budget-checked via callClaude. Suggestions are qualification items to ask next
 * — the UI turns them into one-click inserts (never auto-sent).
 */
export const REPLY_ANALYSIS_PROMPT_VERSION = "reply-analysis/v1";

export const REPLY_ANALYSIS_SYSTEM = `You analyse a prospect's latest reply to Venture CO Group's BDR. Return:
- intent: one of interested | objection | not_now | referral
- objection: the main objection in one short phrase, or null if none
- suggestions: the TWO qualification items most useful to ask next, chosen from: authority, history, budget, timeline

Base your analysis only on the conversation — do not invent facts.`;

export const replyAnalysisSchema = z.object({
  intent: z.enum(["interested", "objection", "not_now", "referral"]),
  objection: z.string().nullish(),
  suggestions: z.array(z.enum(["authority", "history", "budget", "timeline"])).max(2),
});

export type ReplyAnalysis = z.infer<typeof replyAnalysisSchema>;

export function buildReplyMessage(history: string, latest: string): string {
  return `Conversation so far:\n${history || "(none)"}\n\nLatest prospect reply:\n${latest}\n\nAnalyse it.`;
}
