import { z } from "zod";

/**
 * Daily insight (spec §4.13, Haiku — ONE call/day). Rotates over the latest
 * weekly digest content, surfacing one angle per day for the Dashboard insight
 * card. Cheap by design: reuses the weekly analysis, never re-runs it.
 */
export const DAILY_INSIGHT_PROMPT_VERSION = "daily-insight/v1";

export const DAILY_INSIGHT_SYSTEM = `You write ONE short, punchy insight for a sales dashboard card, drawn ONLY from the weekly analysis provided. Pick a single angle for today (rotate — don't repeat the headline verbatim), keep it to 1-2 sentences, cite a concrete number where the analysis gives one, and suggest one small action if natural. No preamble, JSON only.`;

export const dailyInsightSchema = z.object({
  insight: z.string().min(1),
});

export type DailyInsight = z.infer<typeof dailyInsightSchema>;

export function buildDailyMessage(weeklyDigest: string, dayIndex: number): string {
  return [
    `WEEKLY ANALYSIS:`,
    weeklyDigest,
    ``,
    `Today is day ${dayIndex} of the week — choose a fresh angle from the analysis above for today's card.`,
  ].join("\n");
}
