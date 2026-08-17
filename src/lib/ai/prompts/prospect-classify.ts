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

Give each a priority from 1 (contact first) to 5 (deprioritize). Base your judgement only on the provided fields — do not invent details. Return one entry per input index.

Answer with a JSON object of exactly this shape, and nothing else:

{"items":[{"index":0,"fit":"strong","priority":1,"note":"one short reason"}]}

The top level is an OBJECT with an "items" array — not a bare array.`;

/**
 * The classifier's output.
 *
 * ── WHY THE PREPROCESS ──────────────────────────────────────────────────────
 *
 * Production logs carried `ClaudeJsonError: ... items: Required`. The system
 * prompt said "return one entry per input index" and never said what the JSON
 * should look like, so the model quite reasonably answered with a bare array —
 * `[{...},{...}]` — and validation failed after the repair retry, costing two
 * Haiku calls and giving the operator an opaque server error.
 *
 * The prompt now states the shape explicitly, which is the actual fix. This
 * preprocess is the belt: a bare array is exactly the answer we asked an
 * ambiguous question for, and rejecting it on a technicality helps nobody.
 */
export const prospectClassificationSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { items: value } : value),
  z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      fit: z.enum(["strong", "possible", "skip"]),
      priority: z.number().int().min(1).max(5),
      note: z.string().nullish(),
    }),
  ),
  }),
);

export type ProspectClassification = z.infer<typeof prospectClassificationSchema>;

export function buildClassifyMessage(
  rows: Array<{ index: number; name: string; category: string | null; website: string }>,
): string {
  const lines = rows
    .map((r) => `${r.index}. ${r.name} — category: ${r.category ?? "?"} — website: ${r.website}`)
    .join("\n");
  return `Classify these ${rows.length} businesses. Return one item per index.\n\n${lines}`;
}
