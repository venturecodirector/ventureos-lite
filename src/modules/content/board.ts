/**
 * Content Hub board rules (spec §4.12). Pure — the transition table and its
 * permissions are testable without a database or a session.
 */

export const CONTENT_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const STATUS_LABEL: Record<ContentStatus, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  APPROVED: "Approved",
  PUBLISHED: "Published",
};

/**
 * Which moves are legal, and who may make them.
 *
 * `approverOnly` marks the two transitions that constitute an editorial
 * decision — approving copy, and reverting something already approved. Those
 * are Owner/Admin; a BDR can write and submit but not sign off their own work.
 * Publishing is deliberately NOT restricted: it records that a human posted the
 * text, and whoever does the posting records it.
 */
interface Transition {
  to: ContentStatus;
  label: string;
  approverOnly: boolean;
}

const TRANSITIONS: Record<ContentStatus, Transition[]> = {
  DRAFT: [{ to: "IN_REVIEW", label: "Submit for review", approverOnly: false }],
  IN_REVIEW: [
    { to: "APPROVED", label: "Approve", approverOnly: true },
    { to: "DRAFT", label: "Send back to draft", approverOnly: false },
  ],
  APPROVED: [
    { to: "PUBLISHED", label: "Mark published", approverOnly: false },
    { to: "DRAFT", label: "Reopen", approverOnly: true },
  ],
  PUBLISHED: [{ to: "DRAFT", label: "Reopen", approverOnly: true }],
};

export function allowedTransitions(from: ContentStatus, isApprover: boolean): Transition[] {
  return TRANSITIONS[from].filter((t) => !t.approverOnly || isApprover);
}

export type TransitionCheck =
  | { allowed: true }
  | { allowed: false; reason: "illegal" | "forbidden"; message: string };

export function canTransition(
  from: ContentStatus,
  to: ContentStatus,
  isApprover: boolean,
): TransitionCheck {
  const move = TRANSITIONS[from].find((t) => t.to === to);
  if (!move) {
    return {
      allowed: false,
      reason: "illegal",
      message: `A post cannot go straight from ${STATUS_LABEL[from]} to ${STATUS_LABEL[to]}.`,
    };
  }
  if (move.approverOnly && !isApprover) {
    return {
      allowed: false,
      reason: "forbidden",
      message: "Only an Owner or Admin can approve or reopen a post.",
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// channel limits
// ---------------------------------------------------------------------------

export const CHANNELS = [
  { key: "linkedin", label: "LinkedIn", maxChars: 3000 },
  { key: "blog", label: "Blog", maxChars: null },
  { key: "newsletter", label: "Newsletter", maxChars: null },
] as const;

export type ChannelKey = (typeof CHANNELS)[number]["key"];

export function isChannel(v: string): v is ChannelKey {
  return CHANNELS.some((c) => c.key === v);
}

export function maxCharsFor(channel: string): number | null {
  return CHANNELS.find((c) => c.key === channel)?.maxChars ?? null;
}

export function isOverLimit(channel: string, body: string): boolean {
  const max = maxCharsFor(channel);
  return max !== null && body.length > max;
}

/**
 * A post cannot be submitted or published empty or over its channel limit.
 * Checked server-side; the board also uses it to explain the disabled state.
 */
export type PostGate = { ok: true } | { ok: false; message: string };

export function validateForStatus(input: {
  status: ContentStatus;
  title: string;
  body: string;
  channel: string;
}): PostGate {
  if (input.status === "DRAFT") return { ok: true };
  if (!input.title.trim()) return { ok: false, message: "Give the post a title first." };
  if (!input.body.trim()) return { ok: false, message: "The post is empty." };
  if (isOverLimit(input.channel, input.body)) {
    const max = maxCharsFor(input.channel)!;
    return {
      ok: false,
      message: `LinkedIn caps a post at ${max} characters — trim ${input.body.length - max}.`,
    };
  }
  return { ok: true };
}
