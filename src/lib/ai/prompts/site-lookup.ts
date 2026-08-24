import { z } from "zod";

/**
 * Find a company's own website (Haiku + Anthropic web search).
 *
 * Haiku, not Sonnet: CLAUDE.md rule #3 names the four Sonnet use cases and
 * "find a URL" is not one of them — this is a lookup, and the hard part is
 * search, not prose.
 *
 * It costs a real search ($0.01) on top of tokens, so it runs ONLY when the
 * operator clicks Lookup on a lead with no domain. When the domain is already
 * there, the site is simply read: no model call at all.
 *
 * The prompt's whole job is to keep the model from answering with a directory
 * listing, which is what a search for a company name actually returns. The
 * instruction is backed by a deterministic block-list on the way out
 * (`isDirectoryDomain`), because a prompt is guidance and that check is not.
 */
export const SITE_LOOKUP_PROMPT_VERSION = "site-lookup/v1";

export const SITE_LOOKUP_SYSTEM = `You find the official website of a company for a B2B salesperson at Venture CO Group, a Hungarian agency. Most of the companies are Hungarian small and mid-sized businesses.

Use web search to find the company's OWN website — the site the company itself runs.

Rules:
- Answer with the bare hostname only: "example.hu", never "https://www.example.hu/about".
- The company's own site ONLY. Never a directory, registry, social profile, job board, marketplace or news article about it: linkedin.com, facebook.com, cegjegyzek.hu, opten.hu, nevjegy.hu, cylex.hu, profession.hu, crunchbase.com and their kind are always wrong answers.
- Hungarian companies are commonly on .hu, but a .com is just as valid — go by the evidence, not by the extension.
- Names collide. If the search results are about a different company with a similar name, or you cannot tell which of several is meant, answer with null. A wrong domain costs the salesperson more than an empty field.
- Set confidence honestly: "high" only when the site itself names the company; "medium" when the match is strong but indirect; "low" when it is a guess.
- Never invent a domain, and never answer from memory without a search result behind it.

Return ONLY this JSON value:

{
  "domain": "string — bare hostname, or null if you are not sure",
  "confidence": "high" | "medium" | "low",
  "evidenceUrl": "string — the page that convinced you, or null",
  "reason": "string — one short sentence, in English"
}`;

export const siteLookupSchema = z.object({
  domain: z.string().trim().min(1).max(253).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceUrl: z.string().trim().max(2000).nullable(),
  reason: z.string().trim().max(400),
});

export type SiteLookupAnswer = z.infer<typeof siteLookupSchema>;

export function buildSiteLookupMessage(input: {
  companyName: string;
  city?: string | null;
  taxId?: string | null;
  contactName?: string | null;
}): string {
  const parts = [
    `Company name: ${input.companyName}`,
    input.city && `City: ${input.city}`,
    // The adószám is the one identifier that cannot belong to two companies, so
    // it is worth giving even though a search engine rarely indexes it.
    input.taxId && `Hungarian tax number (adószám): ${input.taxId}`,
    input.contactName && `A person who works there: ${input.contactName}`,
  ].filter(Boolean);
  return `Find the official website of this company.\n\n${parts.join("\n")}`;
}
