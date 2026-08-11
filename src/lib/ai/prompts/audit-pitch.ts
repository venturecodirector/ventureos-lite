import type { AuditAnalysis } from "@/modules/audit/types";

/**
 * Audit pitch-angle summary (spec §4.4 / §5, Haiku). Optional, off by default,
 * cached 30 days per domain with the audit. 3 sentences a BDR can lead with.
 */
export const AUDIT_PITCH_PROMPT_VERSION = "audit-pitch/v1";

export const AUDIT_PITCH_SYSTEM = `You write a short, concrete pitch angle for Venture CO Group, a Hungarian agency that builds websites and digital projects. Given a website audit (opportunity score, failed checks, and flags), write AT MOST 3 sentences a BDR can open a conversation with. Lead with the strongest, most concrete opportunity. Reference specific findings; do not invent facts, numbers, or business details not in the audit. No preamble, no bullet points — just the pitch.`;

export function buildAuditPitchMessage(url: string, analysis: AuditAnalysis): string {
  const failed = analysis.checks
    .filter((c) => !c.pass)
    .map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}`)
    .join(", ");
  return [
    `Site: ${url}`,
    `Opportunity score: ${analysis.score}/100 (${analysis.verdict})`,
    `Failed checks: ${failed || "none"}`,
    `Flags: ${analysis.flags.join(", ") || "none"}`,
  ].join("\n");
}
