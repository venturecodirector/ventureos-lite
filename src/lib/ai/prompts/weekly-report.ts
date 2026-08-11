import { z } from "zod";
import type { WeeklyReport } from "../../../modules/analytics/reports";

/**
 * Friday report "what worked" commentary (spec §4.14, Haiku). The report NUMBERS
 * are deterministic and rendered without AI; this call only adds a short
 * narrative. Aggregates only — no lead-level data.
 */
export const WEEKLY_REPORT_PROMPT_VERSION = "weekly-report/v1";

export const WEEKLY_REPORT_SYSTEM = `You write the "what worked this week" note for a small sales team's Friday report. You are given AGGREGATE numbers only. Write 2-3 sentences: what performed well (name the source/segment/funnel step with its number), what to watch, and one suggestion. No preamble, JSON only.`;

export const weeklyReportSchema = z.object({
  commentary: z.string().min(1),
});

export type WeeklyReportCommentary = z.infer<typeof weeklyReportSchema>;

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

export function buildWeeklyReportMessage(r: WeeklyReport): string {
  const kpis = r.kpis
    .map((k) => `${k.metric}: ${k.value}${k.target != null ? ` / target ${k.target} (${pct(k.pct)})` : ""}`)
    .join("; ");
  const sources = r.sources
    .map((s) => `${s.source}: ${s.leads} leads, reply ${pct(s.replyRate)}, ${s.revenue.toLocaleString("en-US")} HUF`)
    .join("; ");
  return [
    `WEEK: ${r.weekLabel}`,
    `KPIs: ${kpis}`,
    `PER SOURCE: ${sources || "(none)"}`,
    `AUDIT→MEETING: ${pct(r.auditToMeeting.rate)} (${r.auditToMeeting.meetings}/${r.auditToMeeting.audited})`,
    `DOC CHAIN: acceptance ${pct(r.docChain.acceptanceRate)}, avg days quote→signed ${r.docChain.avgDaysToSigned?.toFixed(1) ?? "—"}`,
    ``,
    `Write the what-worked note.`,
  ].join("\n");
}
