import { z } from "zod";

/**
 * Prospector batch classification (spec §4.3 / §5, Haiku). One call per ~25 rows
 * — Claude classifies ICP fit, it never finds the businesses. Off by default.
 */
export const PROSPECT_CLASSIFY_PROMPT_VERSION = "prospect-classify/v1";

export const PROSPECT_CLASSIFY_SYSTEM = `You classify local businesses for Venture CO Group, a Hungarian agency that builds websites and digital projects for small and mid-sized businesses.

For each business you are given a name, category, and website-presence flag (none = no website, facebook = Facebook page only, has = a real website). Rate its fit as a web-development prospect:
- "strong": clear segment fit AND weak/absent web presence (the best prospects).
- "possible": some fit but less obvious, or already has a website.
- "skip": poor fit or not a business Venture serves.

Give each a priority from 1 (contact first) to 5 (deprioritize). Base your judgement only on the provided fields — do not invent details. Return one entry per input index.`;

export const prospectClassificationSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      fit: z.enum(["strong", "possible", "skip"]),
      priority: z.number().int().min(1).max(5),
      note: z.string().nullish(),
    }),
  ),
});

export type ProspectClassification = z.infer<typeof prospectClassificationSchema>;

export function buildClassifyMessage(
  rows: Array<{ index: number; name: string; category: string | null; website: string }>,
): string {
  const lines = rows
    .map((r) => `${r.index}. ${r.name} — category: ${r.category ?? "?"} — website: ${r.website}`)
    .join("\n");
  return `Classify these ${rows.length} businesses. Return one item per index.\n\n${lines}`;
}
