import Anthropic from "@anthropic-ai/sdk";

/**
 * Server-side-only Anthropic client. NEVER exposed to the client (CLAUDE.md).
 *
 * The key is resolved per workspace — a workspace may hold its own in Settings
 * → Integrations, otherwise ANTHROPIC_API_KEY is used. Clients are cached by
 * key so a multi-workspace deployment does not rebuild one per call.
 */
const clients = new Map<string, Anthropic>();

export function getAnthropic(apiKey?: string | null): Anthropic {
  const key = apiKey?.trim() || process.env.ANTHROPIC_API_KEY || "";
  const cacheKey = key || "(env)";
  let client = clients.get(cacheKey);
  if (!client) {
    client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
    clients.set(cacheKey, client);
  }
  return client;
}
