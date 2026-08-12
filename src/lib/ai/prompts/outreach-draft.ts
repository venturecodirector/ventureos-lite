import { z } from "zod";

/**
 * Outreach draft + critique (spec §4.6 / §5, Sonnet — writing quality).
 * Manual trigger only, budget-checked via callClaude (CLAUDE.md hard rule #3).
 *
 * The draft is a STARTING POINT, never a send-ready message: hard rule #6 means
 * a human must change it before it can be marked Sent. The prompt is written to
 * produce something worth editing rather than something that looks finished.
 */
export const OUTREACH_DRAFT_PROMPT_VERSION = "outreach-draft/v1";

export const OUTREACH_DRAFT_SYSTEM = `You draft first-touch B2B outreach for Venture CO Group, a Hungarian web development and digital agency. The reader is a business owner or manager, usually of a small or mid-sized Hungarian company.

Rules:
- Write in the language named in the request (Hungarian or English). Hungarian must be natural and use informal-professional "Ön" register unless told otherwise.
- Ground every claim in the DATA you are given. Never invent a fact, a metric, a mutual connection, or a compliment about something you cannot see.
- No flattery openers ("I came across your impressive company"), no "I hope this finds you well", no fake urgency, no growth-hack cliches.
- One specific, concrete observation beats three vague benefits.
- End with a low-friction ask (a question or a small next step), not a hard pitch.
- Respect the character limit exactly when one is given.
- Plain text only. No markdown, no bullet lists, no subject line, no signature — the sender's signature is appended by the system.

Return the message body and nothing else in the "body" field.`;

export const outreachDraftSchema = z.object({
  body: z.string().min(1),
  /** One line on the angle taken, so the operator knows what to push on. */
  rationale: z.string().default(""),
});

export type OutreachDraft = z.infer<typeof outreachDraftSchema>;

export interface DraftContext {
  step: "connection" | "fu1" | "fu2";
  language: "HU" | "EN";
  maxChars: number | null;
  contactName: string;
  title: string;
  companyName: string;
  city: string;
  signals: readonly string[];
  auditScore: number | null;
  auditFlags: readonly string[];
  /** What already went out, so a follow-up does not repeat the opener. */
  previous: ReadonlyArray<{ step: string; body: string }>;
}

const STEP_BRIEF: Record<DraftContext["step"], string> = {
  connection:
    "A LinkedIn CONNECTION REQUEST NOTE. Very short. Its only job is to earn the accept — do not pitch, do not sell, do not ask for a meeting.",
  fu1: "The FIRST FOLLOW-UP, sent after the connection was accepted but got no reply. Open a specific angle you have not used yet. Do not guilt them for not replying.",
  fu2: "The SECOND AND FINAL FOLLOW-UP. Short, gracious, and explicitly the last one. Leave the door open without asking for anything heavy.",
};

export function buildDraftMessage(ctx: DraftContext): string {
  const lines: string[] = [];
  lines.push(`Write: ${STEP_BRIEF[ctx.step]}`);
  lines.push(`Language: ${ctx.language === "HU" ? "Hungarian" : "English"}`);
  if (ctx.maxChars !== null) {
    lines.push(`HARD LIMIT: ${ctx.maxChars} characters including spaces. Count them.`);
  }
  lines.push("");
  lines.push("DATA (the only facts you may use):");
  lines.push(`- Contact: ${ctx.contactName || "unknown"}${ctx.title ? `, ${ctx.title}` : ""}`);
  lines.push(`- Company: ${ctx.companyName || "unknown"}${ctx.city ? ` (${ctx.city})` : ""}`);
  if (ctx.auditScore !== null) {
    lines.push(`- Website audit score: ${ctx.auditScore}/100`);
  }
  if (ctx.auditFlags.length > 0) {
    lines.push(`- Website problems found: ${ctx.auditFlags.join(", ")}`);
  }
  if (ctx.signals.length > 0) {
    lines.push(`- Trigger signals: ${ctx.signals.join(", ")}`);
  }
  if (ctx.previous.length > 0) {
    lines.push("");
    lines.push("ALREADY SENT to this person (do not repeat these angles):");
    for (const p of ctx.previous) {
      lines.push(`[${p.step}] ${p.body}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// critique
// ---------------------------------------------------------------------------

export const OUTREACH_CRITIQUE_PROMPT_VERSION = "outreach-critique/v1";

export const OUTREACH_CRITIQUE_SYSTEM = `You are a blunt sales-writing editor reviewing one outreach message before a human sends it.

Judge only what is in front of you. Be specific and short — the reader is about to edit this message, not read an essay.

Return:
- verdict: "send" if it would land as-is, "revise" if it needs work
- issues: up to three concrete problems, each one short sentence. Name the actual phrase that is wrong. If there are none, return an empty array.
- strongest: the single best line in the message, quoted.

Things that count as problems: generic flattery, unearned claims, a fact not present in the data, more than one ask, corporate filler, an opener that could have been sent to anyone, or exceeding a stated character limit.`;

export const outreachCritiqueSchema = z.object({
  verdict: z.enum(["send", "revise"]),
  issues: z.array(z.string()).max(3).default([]),
  strongest: z.string().default(""),
});

export type OutreachCritique = z.infer<typeof outreachCritiqueSchema>;

export function buildCritiqueMessage(input: {
  step: string;
  body: string;
  maxChars: number | null;
  companyName: string;
  auditFlags: readonly string[];
}): string {
  const facts = [
    `Company: ${input.companyName || "unknown"}`,
    input.auditFlags.length > 0 ? `Known website problems: ${input.auditFlags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    `Message type: ${input.step}`,
    input.maxChars !== null
      ? `Character limit: ${input.maxChars} (this message is ${input.body.length})`
      : null,
    "",
    "Facts available about the prospect:",
    facts,
    "",
    "The message:",
    input.body,
  ]
    .filter((l) => l !== null)
    .join("\n");
}
