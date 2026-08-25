import { z } from "zod";

/**
 * The prose between the numbers (playbook-v4 P12/2b, Sonnet).
 *
 * ── WHAT IT IS ALLOWED TO TOUCH ────────────────────────────────────────────
 *
 * Only the wording. Every figure in the report is computed deterministically
 * and rendered from `stats`; this call never sees a company, a domain or a URL,
 * and never produces a number the template will print. It writes the sentences
 * that make a table of percentages read like a finding.
 *
 * One call per report, Owner-triggered, Owner-edited before publish. The v4
 * closing block allows exactly two new call sites and this is the second.
 */
export const SECTOR_REPORT_PROMPT_VERSION = "sector-report/v1";

export const SECTOR_REPORT_SYSTEM = `You write the commentary for a published industry report by Venture CO Group, a Hungarian agency that builds websites for small and mid-sized businesses.

The report measures the websites of one sector in one place, anonymously and in aggregate. You are given ONLY aggregate statistics — never a company, a domain or an address, and you must never ask for one or invent one.

Write in HUNGARIAN.

Rules:
- Ground every sentence in the numbers you were given. Never state a figure that is not in them, and never round one into a different claim.
- Write for the OWNER of one of these businesses, not for a marketer. They should recognise their own situation, not feel audited.
- No scare tactics, no "shocking", no percentages presented as scandals. The numbers are interesting enough; overselling them is what makes a report look like an advertisement.
- No sales pitch in the body. The report ends with its own call to action, written by us — do not add one.
- Name what is worth fixing first and say plainly why it matters to a business, in one sentence each.
- Never mention that this was written with AI assistance.

Return ONLY this JSON value:

{
  "summary": "string — 3-5 sentences: what this sample shows, overall",
  "methodologyNote": "string — 2-3 sentences on how the sample was taken and what it does and does not prove",
  "findings": [ { "heading": "string — short", "body": "string — 2-3 sentences" } ],
  "closing": "string — 2-3 sentences: what an owner reading this should do next week"
}

Between three and five findings.`;

export const sectorReportSchema = z.object({
  summary: z.string().trim().min(1).max(1500),
  methodologyNote: z.string().trim().min(1).max(1000),
  findings: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(800),
      }),
    )
    .min(3)
    .max(5),
  closing: z.string().trim().min(1).max(800),
});

export type SectorNarrative = z.infer<typeof sectorReportSchema>;

export function buildSectorReportMessage(input: {
  sector: string;
  location: string;
  found: number;
  audited: number;
  scoreMedian: number;
  scoreBands: { weak: number; middling: number; strong: number };
  loadMsMedian: number | null;
  failing: Array<{ label: string; share: number; of: number }>;
  categories: Array<{ category: string; median: number }>;
}): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const lines = [
    `Szektor: ${input.sector}`,
    `Terület: ${input.location}`,
    `A keresés ${input.found} vállalkozást talált; ebből ${input.audited} weboldalát tudtuk megmérni.`,
    `Az átvilágítási pontszám mediánja: ${input.scoreMedian}/100 (a MAGASABB pontszám gyengébb oldalt jelent).`,
    `Megoszlás: ${input.scoreBands.weak} gyenge, ${input.scoreBands.middling} közepes, ${input.scoreBands.strong} erős.`,
    input.loadMsMedian != null
      ? `Betöltési idő mediánja: ${(input.loadMsMedian / 1000).toFixed(1)} másodperc.`
      : null,
    "",
    "Hiányzó alapok (a mért oldalak arányában):",
    ...input.failing.map((f) => `- ${f.label}: ${pct(f.share)} (${f.of} mért oldalból)`),
    "",
    "A leggyengébb területek mediánja:",
    ...input.categories.map((c) => `- ${c.category}: ${c.median}/100`),
  ].filter((l) => l !== null);

  return `Írd meg a riport szöveges részeit.\n\n${lines.join("\n")}`;
}
