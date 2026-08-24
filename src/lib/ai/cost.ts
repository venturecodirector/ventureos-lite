import type { ModelId } from "./models";

/**
 * USD cost per call. Pricing is per 1M tokens, verified against the Anthropic
 * model catalog:
 *   claude-sonnet-4-6 — $3 in / $15 out
 *   claude-haiku-4-5  — $1 in / $5 out
 * Prompt caching: cache reads bill at ~0.1x the input rate; 5-minute ephemeral
 * cache writes at ~1.25x.
 */
export const PRICING: Record<ModelId, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Anthropic's server-side web search bills PER SEARCH ($10 / 1,000), on top of
 * the tokens the results consume. Leaving it out would make every searching
 * call look cheaper than it is and let the daily cap be overrun silently, which
 * is exactly what the cap exists to prevent.
 */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

/** Server-side tool calls Anthropic ran inside a single request. */
export interface ClaudeServerToolUse {
  web_search_requests?: number | null;
}

export interface ClaudeUsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function computeCostUsd(
  model: ModelId,
  u: ClaudeUsageTokens,
  serverTools?: ClaudeServerToolUse | null,
): number {
  const p = PRICING[model];
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const inputUsd =
    (u.input_tokens * p.input +
      cacheRead * p.input * CACHE_READ_MULTIPLIER +
      cacheWrite * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  const outputUsd = (u.output_tokens * p.output) / 1_000_000;
  const searchUsd =
    (serverTools?.web_search_requests ?? 0) * WEB_SEARCH_USD_PER_REQUEST;
  return inputUsd + outputUsd + searchUsd;
}
