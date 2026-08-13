import { z } from "zod";

/**
 * Person brief (P1/1e, Haiku). Two or three sentences of plain fact about the
 * person whose profile the user is looking at, written from the captured text
 * ONLY.
 *
 * Haiku, not Sonnet: CLAUDE.md names the four Sonnet use cases and a summary
 * is not one of them. One call per capture, cached on the lead — a re-capture
 * of the same profile does not pay again.
 */
export const PERSON_BRIEF_PROMPT_VERSION = "person-brief/v1";

export const PERSON_BRIEF_SYSTEM = `You summarise a business contact for a B2B salesperson at Venture CO Group, a Hungarian agency delivering websites and digital projects to small and mid-sized businesses.

Write 2-3 sentences of plain, factual summary from the supplied profile text. Rules:
- Ground every statement in the supplied text. Never infer, embellish or guess.
- No sales language, no adjectives of praise, no recommendations.
- If the text is too thin to summarise, say exactly what is known and stop.
- Write in the language of the profile text (Hungarian profile → Hungarian brief).
- Never mention that you are an AI or describe the text you were given.

Return ONLY this JSON value:

{ "brief": "string — 2-3 sentences" }`;

export const personBriefSchema = z.object({ brief: z.string().min(1).max(1200) });

const MAX_CHARS = 4000;

export function buildPersonBriefMessage(input: {
  name?: string | null;
  headline?: string | null;
  bio?: string | null;
  posts?: string[];
}): string {
  const parts = [
    input.name && `Name: ${input.name}`,
    input.headline && `Headline: ${input.headline}`,
    input.bio && `About:\n${input.bio}`,
    input.posts?.length && `Recent posts:\n${input.posts.slice(0, 3).join("\n---\n")}`,
  ].filter(Boolean);
  return `Summarise this contact.\n\n--- PROFILE ---\n${parts.join("\n\n").slice(0, MAX_CHARS)}`;
}
