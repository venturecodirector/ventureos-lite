import { z } from "zod";

/**
 * Company-page post drafting (spec §4.12, "brand voice locked").
 *
 * Haiku, not Sonnet: CLAUDE.md hard rule #3 reserves Sonnet for research cards,
 * outreach drafts, meeting briefs and the weekly analysis. Content posts are
 * not on that list, so they run on the cheap model.
 *
 * "Brand voice locked" is the point of this prompt. The voice rules below are
 * not suggestions the caller can override — the topic and any angle come in as
 * DATA, while the voice stays fixed, so a post cannot drift into whatever
 * register the person typing happened to use in the brief.
 */
export const CONTENT_DRAFT_PROMPT_VERSION = "content-draft/v1";

export const CONTENT_DRAFT_SYSTEM = `You write short company-page posts for Venture CO Group, a Hungarian web development and digital agency selling to owners and managers of small and mid-sized Hungarian companies.

THE VOICE IS FIXED. It does not change to match the brief:
- Plain, concrete, unhurried. Short sentences. No hype, no exclamation marks.
- Practitioner tone: we build these things, so we describe what we have seen, not what "businesses today" supposedly face.
- Specific over general. One real observation beats three abstractions.
- No engagement bait: no "What do you think?", no "Agree?", no rhetorical question openers, no numbered "5 reasons" listicles, no emoji.
- No corporate filler: "in today's fast-paced world", "leverage", "solutions", "game-changer", "unlock".
- Hungarian posts use natural business Hungarian, not translated English. Address the reader as "Ön" only if the post speaks to one person; otherwise stay impersonal.
- Never invent a client name, a statistic, a case study or a result. If the brief gives you no numbers, write without numbers.
- Close with a plain statement or a small concrete offer, not a call to action shouting for comments.

Length: aim for 120–220 words unless the brief says otherwise. LinkedIn hard-caps a post at 3000 characters.

Return the post body only — no title, no hashtags block, no signature.`;

export const contentDraftSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  /** One line on the angle taken, so the reviewer knows what to push on. */
  rationale: z.string().default(""),
});

export type ContentDraft = z.infer<typeof contentDraftSchema>;

export interface ContentBrief {
  topic: string;
  channel: string;
  language: "HU" | "EN";
  /** Optional extra context the operator typed — treated as data, not voice. */
  notes?: string;
  /** Workspace brand details, so the post is grounded in who we are. */
  companyName: string;
}

export function buildContentMessage(brief: ContentBrief): string {
  const lines = [
    `Channel: ${brief.channel}`,
    `Language: ${brief.language === "HU" ? "Hungarian" : "English"}`,
    `Posting as: ${brief.companyName}`,
    "",
    `Topic: ${brief.topic}`,
  ];
  if (brief.notes?.trim()) {
    lines.push("", "Additional context (facts only — the voice rules still apply):", brief.notes.trim());
  }
  lines.push("", "Write the post, and give it a short internal title.");
  return lines.join("\n");
}
