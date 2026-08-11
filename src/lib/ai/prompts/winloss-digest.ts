import { z } from "zod";
import type { OutcomeTotals } from "../../../modules/analytics/data";
import type { WhatCloses, AggRow } from "../../../modules/analytics/aggregate";

/**
 * Quarterly win/loss digest (spec §4.20, Haiku). AGGREGATES ONLY — no lead
 * names, contacts, or per-deal rows ever reach the model. It receives ranked
 * close-rate/revenue tables and writes a short Owner-facing narrative.
 */
export const WINLOSS_DIGEST_PROMPT_VERSION = "winloss-digest/v1";

export const WINLOSS_DIGEST_SYSTEM = `You write a concise quarterly win/loss digest for the owner of a small B2B sales team. You are given ONLY aggregate numbers (close rates and revenue by hook, signal, source, segment, and audit-score band). Never invent specific companies or people — you don't have them.

Return JSON:
- headline: one sentence summarising the quarter's close performance.
- whatWorks: 2-3 short bullet strings naming the dimensions that close best (by revenue and close rate).
- whatDrags: 1-2 short bullet strings naming weak spots or where deals stall/lose.
- recommendation: one sentence on where to focus next quarter.

Be specific with the numbers you're given. No preamble, JSON only.`;

export const winlossDigestSchema = z.object({
  headline: z.string().min(1),
  whatWorks: z.array(z.string()).min(1).max(3),
  whatDrags: z.array(z.string()).max(2),
  recommendation: z.string().min(1),
});

export type WinLossDigest = z.infer<typeof winlossDigestSchema>;

function fmtRows(rows: AggRow[]): string {
  if (!rows.length) return "  (none)";
  return rows
    .slice(0, 6)
    .map(
      (r) =>
        `  - ${r.key}: ${r.won}W/${r.lost}L/${r.postponed}P, close ${(r.closeRate * 100).toFixed(
          0,
        )}%, revenue ${r.revenue.toLocaleString("en-US")} HUF`,
    )
    .join("\n");
}

export function buildDigestMessage(totals: OutcomeTotals, w: WhatCloses): string {
  return [
    `QUARTER TOTALS: ${totals.deals} deals — ${totals.won} won, ${totals.lost} lost, ${totals.postponed} postponed. Revenue ${totals.revenue.toLocaleString("en-US")} HUF.`,
    ``,
    `BY HOOK:\n${fmtRows(w.byHook)}`,
    `BY SIGNAL:\n${fmtRows(w.bySignal)}`,
    `BY SOURCE:\n${fmtRows(w.bySource)}`,
    `BY SEGMENT:\n${fmtRows(w.bySegment)}`,
    `BY AUDIT-SCORE BAND:\n${fmtRows(w.byScoreBand)}`,
    ``,
    `Write the digest.`,
  ].join("\n");
}
