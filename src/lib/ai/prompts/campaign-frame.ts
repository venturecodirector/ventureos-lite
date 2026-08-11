import { z } from "zod";

/**
 * Cold-email frame draft (spec §4.16, Sonnet — ONE call per campaign, NEVER per
 * recipient). Produces a 2-3 step plain-text sequence with personalization
 * SLOTS (e.g. {{company}}, {{audit_link}}) that are later filled from audit and
 * registry data by pure template rendering. The model sees no individual lead.
 */
export const CAMPAIGN_FRAME_PROMPT_VERSION = "campaign-frame/v1";

export const CAMPAIGN_FRAME_SYSTEM = `You draft a cold B2B outreach SEQUENCE for a Hungarian web/marketing agency (Venture CO Group). Output plain text only — no HTML, no markdown. Write in the language implied by the brief (default Hungarian).

Rules:
- 2 or 3 steps total. Step 1 is the opener; later steps are short follow-ups that add ONE concrete value point.
- Use ONLY these personalization slots where relevant: {{company}}, {{city}}, {{audit_score}}, {{audit_finding}}, {{audit_link}}, {{booking_link}}. Do not invent other slots. Every value comes from data, not from you.
- Plain-text-first, concise, human, no spammy phrasing. No images. No "Dear Sir/Madam".
- Do NOT write an unsubscribe footer — the system injects a mandatory one on every step.
- The sequence stops automatically on reply; write follow-ups assuming no reply yet.

Return JSON only.`;

export const campaignFrameSchema = z.object({
  frameName: z.string().min(1),
  steps: z
    .array(
      z.object({
        stepNumber: z.number().int().min(1),
        delayDays: z.number().int().min(0),
        subject: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .min(2)
    .max(3),
});

export type CampaignFrame = z.infer<typeof campaignFrameSchema>;

export function buildFrameMessage(brief: {
  name: string;
  segmentDescription: string;
  language: string;
  goal: string;
}): string {
  return [
    `CAMPAIGN: ${brief.name}`,
    `AUDIENCE: ${brief.segmentDescription}`,
    `LANGUAGE: ${brief.language}`,
    `GOAL: ${brief.goal}`,
    ``,
    `Draft the 2-3 step sequence with slots. JSON only.`,
  ].join("\n");
}
