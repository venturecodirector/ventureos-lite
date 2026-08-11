/**
 * Optional contract scope-paragraph assist (spec §4.9 / §5, Haiku). This is a
 * separate, labeled, human-approved button — NOT in the render path. The
 * document itself always renders from templates + variables only.
 */
export const DOC_SCOPE_PROMPT_VERSION = "doc-scope/v1";

export const DOC_SCOPE_SYSTEM = `You draft a concise scope-of-work paragraph (Hungarian) for a Venture CO Group service contract, based on the accepted quote's line items. 2–4 sentences, plain and specific, no marketing language, no invented deliverables beyond the line items. Return only the paragraph.`;

export function buildScopeMessage(items: Array<{ description: string }>): string {
  const lines = items.map((i) => `- ${i.description}`).join("\n");
  return `Line items from the accepted quote:\n${lines}\n\nWrite the scope paragraph.`;
}
