import { z } from "zod";

/**
 * Lead research card prompt (spec §4.2 / §5, Sonnet). Versioned per CLAUDE.md
 * ("prompts live in src/lib/ai/prompts as versioned TS constants"). The system
 * prompt is static so it prompt-caches; the per-lead profile rides in the user
 * turn. Claude proposes the ICP breakdown; the score is computed deterministically
 * from it (never by the model).
 */
export const LEAD_RESEARCH_PROMPT_VERSION = "lead-research/v1";

export const LEAD_RESEARCH_SYSTEM = `You are a B2B sales research assistant for Venture CO Group, a Hungarian agency that delivers websites and full-stack digital projects to small and mid-sized businesses (HoReCa, manufacturing, private clinics, professional services, trades).

From the profile text provided, produce a structured lead research card. Be concise, factual, and grounded ONLY in the supplied text — never invent facts, contact details, or numbers. When something is unknown, say so in the summary rather than guessing.

Score the lead against the Ideal Customer Profile using exactly these five criteria, each worth 0 or 1:
- segment_fit: the business is in a segment Venture serves and plausibly needs web/digital work.
- trigger_signal: there is a concrete trigger (outdated/absent website, hiring marketing, expansion, compliance gap, new leadership).
- decision_maker: the person is an owner or decision-maker (or a direct path to one).
- active_profile: the person/company is active online (recent posts, updates) — a warm contact surface.
- personal_hook: there is a specific, non-generic hook to open a conversation.

Write the pain points and hook so a BDR could act on them immediately. The hook must reference something concrete from the profile.`;

const bit = z.union([z.literal(0), z.literal(1)]);

export const leadCardSchema = z.object({
  company: z.object({
    name: z.string(),
    industry: z.string().nullish(),
    sizeEmployees: z.number().int().nullish(),
    summary: z.string(),
  }),
  person: z.object({
    name: z.string(),
    title: z.string().nullish(),
    summary: z.string(),
  }),
  signals: z.array(z.string()),
  pains: z.array(z.string()),
  hook: z.string(),
  icp: z.object({
    segment_fit: bit,
    trigger_signal: bit,
    decision_maker: bit,
    active_profile: bit,
    personal_hook: bit,
  }),
});

export type LeadCard = z.infer<typeof leadCardSchema>;

const MAX_PROFILE_CHARS = 6000;

/** Pre-trim the profile text before it hits the API (spec §6.6). */
export function buildResearchUserMessage(profileText: string): string {
  const trimmed = profileText.replace(/\s+\n/g, "\n").trim().slice(0, MAX_PROFILE_CHARS);
  return `Research this lead and return the structured card.\n\n--- PROFILE ---\n${trimmed}`;
}
