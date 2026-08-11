import { z } from "zod";

/**
 * Meeting brief (spec §4.8, Sonnet). Compiles company profile, person
 * background, audit findings, hypothesised pain, and the full conversation into
 * an editable one-page brief with exactly five discovery questions. This is the
 * ONE permitted non-manual Claude trigger (fires on entering Meeting-booked),
 * bounded to one call per booking. No AI enters legal documents.
 */
export const MEETING_BRIEF_PROMPT_VERSION = "meeting-brief/v1";

export const MEETING_BRIEF_SYSTEM = `You are preparing Venture CO Group's founder for a first sales meeting with a prospect. Produce a tight, factual one-page brief. Use ONLY the context provided — never invent people, numbers, or facts; if something is unknown, say so briefly.

Return JSON with:
- companyProfile: 2-3 sentences on the company (what they do, size/sector signals).
- personBackground: 1-2 sentences on the individual you'll meet; "Unknown" if no data.
- auditFindings: array of up to 4 short bullet strings drawn from the website audit; empty if none.
- hypothesizedPain: 2-3 sentences naming the most likely business pain Venture can solve, grounded in the audit and conversation.
- conversationSummary: 2-3 sentences summarising the thread so far; "No prior conversation." if empty.
- discoveryQuestions: EXACTLY five open discovery questions to ask in the meeting, ordered from rapport to commercial.

Keep it crisp and human. No preamble, JSON only.`;

export const meetingBriefSchema = z.object({
  companyProfile: z.string().min(1),
  personBackground: z.string().min(1),
  auditFindings: z.array(z.string()).max(4),
  hypothesizedPain: z.string().min(1),
  conversationSummary: z.string().min(1),
  discoveryQuestions: z.array(z.string().min(1)).length(5),
});

export type MeetingBrief = z.infer<typeof meetingBriefSchema>;

export interface BriefContext {
  companyName: string;
  companyMeta: string;
  contactName: string;
  contactMeta: string;
  auditSummary: string;
  conversation: string;
}

export function buildBriefMessage(ctx: BriefContext): string {
  return [
    `COMPANY: ${ctx.companyName}`,
    ctx.companyMeta && `COMPANY DETAILS: ${ctx.companyMeta}`,
    `CONTACT: ${ctx.contactName || "Unknown"}`,
    ctx.contactMeta && `CONTACT DETAILS: ${ctx.contactMeta}`,
    ``,
    `WEBSITE AUDIT FINDINGS:`,
    ctx.auditSummary || "(no audit on file)",
    ``,
    `CONVERSATION HISTORY:`,
    ctx.conversation || "(no prior conversation)",
    ``,
    `Write the meeting brief.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Serialise the structured brief into editable plain text (stored on Meeting). */
export function briefToText(b: MeetingBrief): string {
  const findings = b.auditFindings.length
    ? b.auditFindings.map((f) => `  • ${f}`).join("\n")
    : "  • (none on file)";
  const questions = b.discoveryQuestions.map((q, i) => `  ${i + 1}. ${q}`).join("\n");
  return [
    `COMPANY PROFILE`,
    b.companyProfile,
    ``,
    `PERSON`,
    b.personBackground,
    ``,
    `AUDIT FINDINGS`,
    findings,
    ``,
    `HYPOTHESISED PAIN`,
    b.hypothesizedPain,
    ``,
    `CONVERSATION SO FAR`,
    b.conversationSummary,
    ``,
    `DISCOVERY QUESTIONS`,
    questions,
  ].join("\n");
}
