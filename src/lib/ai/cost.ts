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

export interface ClaudeUsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function computeCostUsd(model: ModelId, u: ClaudeUsageTokens): number {
  const p = PRICING[model];
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const inputUsd =
    (u.input_tokens * p.input +
      cacheRead * p.input * CACHE_READ_MULTIPLIER +
      cacheWrite * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  const outputUsd = (u.output_tokens * p.output) / 1_000_000;
  return inputUsd + outputUsd;
}
