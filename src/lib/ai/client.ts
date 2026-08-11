import Anthropic from "@anthropic-ai/sdk";

/**
 * Server-side-only Anthropic client. The API key comes from ANTHROPIC_API_KEY
 * and is NEVER exposed to the client (CLAUDE.md). Constructed lazily so importing
 * the AI module (e.g. in tests) doesn't require the key to be present.
 */
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  }
  return client;
}
