/**
 * Outreach sequence rules (spec §4.6). Pure logic — no I/O, no Prisma — so the
 * guardrail that matters most in this codebase is directly testable.
 *
 * The sequence is deliberately short: a connection note, then at most two
 * follow-ups, then the lead goes to `Not now` rather than being chased forever.
 */

export const OUTREACH_STEPS = ["connection", "fu1", "fu2"] as const;
export type OutreachStep = (typeof OUTREACH_STEPS)[number];

/** LinkedIn's hard limit on a connection request note. */
export const CONNECTION_MAX_CHARS = 300;

/** After this many follow-ups with no reply, the lead is parked (spec §4.6). */
export const MAX_FOLLOW_UPS = 2;

export const STEP_LABEL: Record<OutreachStep, string> = {
  connection: "Connection note",
  fu1: "Follow-up 1",
  fu2: "Follow-up 2",
};

export function isOutreachStep(v: string): v is OutreachStep {
  return (OUTREACH_STEPS as readonly string[]).includes(v);
}

/** Only the connection note is length-capped; follow-ups are messages. */
export function maxCharsFor(step: OutreachStep): number | null {
  return step === "connection" ? CONNECTION_MAX_CHARS : null;
}

export function isOverLimit(step: OutreachStep, body: string): boolean {
  const max = maxCharsFor(step);
  return max !== null && body.length > max;
}

/** The next step to draft given what has already gone out, or null when done. */
export function nextStep(sentSteps: readonly string[]): OutreachStep | null {
  return OUTREACH_STEPS.find((s) => !sentSteps.includes(s)) ?? null;
}

/**
 * Both follow-ups sent and still nothing back → the lead is parked as `Not now`
 * rather than chased. Replying at any point cancels this.
 */
export function shouldParkAsNotNow(input: {
  sentSteps: readonly string[];
  hasReply: boolean;
}): boolean {
  if (input.hasReply) return false;
  const followUpsSent = input.sentSteps.filter((s) => s === "fu1" || s === "fu2").length;
  return followUpsSent >= MAX_FOLLOW_UPS;
}

// ---------------------------------------------------------------------------
// the human-edit guardrail (CLAUDE.md hard rule #6)
// ---------------------------------------------------------------------------

/**
 * Collapse the differences that are not edits.
 *
 * Whitespace-only churn — a stray trailing space, a line re-wrapped by the
 * textarea, CRLF vs LF — must NOT count as human editing, or the guardrail
 * becomes a formality that any accidental keystroke satisfies. The point of the
 * rule is that a person actually reworked the words.
 */
export function normalizeForComparison(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when `body` differs from what Claude produced in more than whitespace.
 *
 * Accepts undefined as well as null: a partial `select` returns undefined for a
 * column it did not fetch, and treating that as "no draft on record" is both
 * the safe reading and the one that cannot crash a page render.
 */
export function isHumanEdited(
  aiDraftBody: string | null | undefined,
  body: string | null | undefined,
): boolean {
  // Nothing was AI-drafted, so the text is the operator's own by definition.
  if (!aiDraftBody) return true;
  return normalizeForComparison(aiDraftBody) !== normalizeForComparison(body ?? "");
}

export type SendGate =
  | { allowed: true }
  | { allowed: false; reason: "empty" | "unedited" | "too_long"; message: string };

/**
 * The gate `markSent` enforces server-side.
 *
 * A Claude-drafted message cannot be marked Sent until a human has changed it.
 * This is checked by comparing against the stored draft, never by trusting a
 * `humanEdited` boolean coming from the client.
 */
export function evaluateSendGate(input: {
  step: OutreachStep;
  body: string;
  aiDrafted: boolean;
  aiDraftBody: string | null | undefined;
}): SendGate {
  const body = input.body.trim();
  if (!body) {
    return { allowed: false, reason: "empty", message: "Write the message first." };
  }
  if (isOverLimit(input.step, input.body)) {
    return {
      allowed: false,
      reason: "too_long",
      message: `A connection note is capped at ${CONNECTION_MAX_CHARS} characters — trim ${
        input.body.length - CONNECTION_MAX_CHARS
      }.`,
    };
  }
  if (input.aiDrafted && !isHumanEdited(input.aiDraftBody, input.body)) {
    return {
      allowed: false,
      reason: "unedited",
      message:
        "Claude drafted this and you haven't changed it. Make it yours before sending — " +
        "edit at least one line.",
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// audit hooks (spec §4.6: "audit-report insight lines can be inserted as hooks")
// ---------------------------------------------------------------------------

export interface AuditHook {
  /** Short label for the chip in the UI. */
  label: string;
  /** The sentence inserted into the draft. */
  line: string;
}

/**
 * Turn a lead's latest audit into one-click opening lines. These are DATA, not
 * AI output — pure string assembly from the audit's own findings, so inserting
 * one costs nothing and cannot hallucinate.
 */
export function auditHooks(input: {
  companyName: string;
  score: number | null;
  flags: readonly string[];
}): AuditHook[] {
  const hooks: AuditHook[] = [];
  const company = input.companyName.trim() || "your site";

  if (input.score !== null) {
    hooks.push({
      label: `Score ${input.score}`,
      line: `I ran a quick technical check on ${company} — it scores ${input.score}/100.`,
    });
  }
  const FLAG_LINES: Record<string, string> = {
    "no mobile": `${company} isn't mobile-friendly, which is where most of your visitors are.`,
    "outdated website": `${company} looks like it hasn't been refreshed in a few years.`,
    "no https": `${company} isn't served over HTTPS — browsers now flag that to visitors.`,
    "slow": `${company} takes long enough to load that a chunk of visitors leave first.`,
    "no website": `I couldn't find a website for ${company} at all.`,
  };
  for (const flag of input.flags) {
    const line = FLAG_LINES[flag.toLowerCase()];
    if (line) hooks.push({ label: flag, line });
  }
  return hooks.slice(0, 4);
}
