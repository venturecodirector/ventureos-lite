import { z } from "zod";

/**
 * The thank-you after a meeting (playbook-v4 P13/2, Sonnet).
 *
 * Sonnet rather than Haiku because CLAUDE.md names outreach drafting as one of
 * the four writing-quality use cases, and this is the first message after a
 * conversation — the one where a wrong register costs the deal.
 *
 * ONE call, when an outcome is logged. Not on page load, not per recipient.
 * The v4 closing block allows exactly two new call sites and this is one of
 * them.
 *
 * The draft is never sent by the system. It lands in the composer, a person
 * edits it, and a person sends it (CLAUDE.md hard rule #2).
 */
export const MEETING_FOLLOWUP_PROMPT_VERSION = "meeting-followup/v1";

export const MEETING_FOLLOWUP_SYSTEM = `You write the follow-up email after a sales meeting, for a salesperson at Venture CO Group — a Hungarian agency building websites and digital projects for small and mid-sized businesses.

Write in HUNGARIAN unless the notes are clearly in another language, in which case write in that one.

Rules:
- Ground every sentence in the supplied facts. Never invent a commitment, a price, a date or a feature that is not in the notes.
- Short. Four to seven sentences. A follow-up that takes three minutes to read does not get read.
- Recap what was actually discussed, then name the next step that was agreed. If no next step was agreed, propose one concrete, small one.
- Match the outcome. A WON meeting confirms and moves forward; a POSTPONED one leaves the door open without pressure; a LOST one thanks them plainly and does not argue.
- No adjectives of praise, no "excited to", no filler. Write the way a competent person writes to someone whose time they respect.
- Never mention that this was drafted by software.

Return ONLY this JSON value:

{ "subject": "string — under 70 characters", "body": "string — plain text, blank lines between paragraphs" }`;

export const meetingFollowupSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
});

export type MeetingFollowup = z.infer<typeof meetingFollowupSchema>;

const MAX_NOTES = 4000;

export function buildFollowupMessage(input: {
  contactName?: string | null;
  companyName?: string | null;
  outcome: string;
  reason?: string | null;
  value?: number | null;
  notes?: string | null;
  discussedItems?: string[];
}): string {
  const parts = [
    input.contactName && `Kapcsolattartó: ${input.contactName}`,
    input.companyName && `Cég: ${input.companyName}`,
    `A találkozó kimenetele: ${input.outcome}`,
    input.reason && `Indoklás / megjegyzés: ${input.reason}`,
    typeof input.value === "number" && input.value > 0
      ? `Szóba került érték: ${input.value.toLocaleString("hu-HU")} Ft`
      : null,
    input.discussedItems?.length
      ? `Megbeszélt szolgáltatások:\n- ${input.discussedItems.join("\n- ")}`
      : null,
    input.notes && `Jegyzetek a találkozóról:\n${input.notes.slice(0, MAX_NOTES)}`,
  ].filter(Boolean);

  return `Írd meg a találkozó utáni levelet.\n\n${parts.join("\n\n")}`;
}
