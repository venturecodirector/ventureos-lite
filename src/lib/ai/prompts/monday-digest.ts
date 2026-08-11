import { z } from "zod";
import type { DigestModel } from "../../../modules/analytics/reports";

/**
 * Monday per-user digest intro (spec §4.22, Haiku — ONE call per digest,
 * aggregates only). The section numbers are deterministic; this adds a short,
 * friendly one-liner to open the email.
 */
export const MONDAY_DIGEST_PROMPT_VERSION = "monday-digest/v1";

export const MONDAY_DIGEST_SYSTEM = `You write a single warm, focused opening line for a salesperson's Monday morning digest, based only on the aggregate counts provided. One sentence, concrete, points them at what matters most this week. No preamble, JSON only.`;

export const mondayDigestSchema = z.object({
  intro: z.string().min(1),
});

export type MondayDigestIntro = z.infer<typeof mondayDigestSchema>;

export function buildMondayDigestMessage(name: string, model: DigestModel): string {
  const lines = model.sections.map((s) => `${s.label}: ${s.value}`).join("; ");
  return `Recipient: ${name}\nThis week: ${lines}\n\nWrite the opening line.`;
}
