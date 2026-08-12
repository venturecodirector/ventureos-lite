/**
 * Mail provider adapter (spec §4.11). Mailgun EU in production; a mock in dev.
 *
 * Two strictly separated streams (CLAUDE.md → Domain layout):
 *   - "transactional" → MAILGUN_DOMAIN (mg.ventureco.group), MAILGUN_API_KEY
 *   - "cold"          → MAILGUN_COLD_DOMAIN (cold.ventureco.agency),
 *                       MAILGUN_COLD_API_KEY
 *
 * The separation is enforced HERE, not in configuration: a cold send can never
 * fall back to the transactional domain or borrow the transactional key, and a
 * transactional send can never leak onto the cold domain. Both directions throw.
 */
import { coldMailDomain, transactionalMailDomain } from "../../lib/env";

/** Which reputation pool a message belongs to. Defaults to transactional. */
export type MailStream = "transactional" | "cold";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  domain: string;
  /** Omit for transactional mail; cold campaigns MUST pass "cold". */
  stream?: MailStream;
  /**
   * Credentials resolved for the sending workspace (Settings → Integrations),
   * falling back to env when absent. Carried on the message so the provider
   * stays stateless across workspaces.
   */
  credentials?: { apiKey?: string | null; transactionalDomain?: string | null; coldDomain?: string | null };
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachment[];
}

export interface MailProvider {
  readonly name: string;
  send(msg: MailMessage): Promise<{ id: string }>;
}

/** Raised when a message would go out on the wrong sending domain or key. */
export class MailStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailStreamError";
  }
}

/**
 * Gate every outbound message on the stream/domain pair before it can reach a
 * provider. Runs for the mock too, so tests and dev catch a mis-routed send.
 * Returns the API-key env var name that stream is allowed to use.
 */
export function assertStreamDomain(msg: MailMessage): "MAILGUN_API_KEY" | "MAILGUN_COLD_API_KEY" {
  const stream: MailStream = msg.stream ?? "transactional";
  const domain = msg.domain.trim().toLowerCase();
  // Prefer the workspace-resolved domains; fall back to env. The rule is the
  // same either way — where the values came from does not change it.
  const tx = (msg.credentials?.transactionalDomain ?? transactionalMailDomain())?.toLowerCase() ?? null;
  const cold = (msg.credentials?.coldDomain ?? coldMailDomain())?.toLowerCase() ?? null;

  if (!domain) {
    throw new MailStreamError("Refusing to send: no sending domain resolved.");
  }
  if (tx && cold && tx === cold) {
    throw new MailStreamError(
      `Refusing to send: MAILGUN_DOMAIN and MAILGUN_COLD_DOMAIN are both "${tx}". ` +
        "Cold outreach must have its own sending domain.",
    );
  }

  if (stream === "cold") {
    // The invariant: cold traffic never touches the transactional reputation.
    // A workspace may run its own cold domain (Workspace.featureFlags →
    // coldEmail.coldDomain), so the domain need not equal MAILGUN_COLD_DOMAIN —
    // it must simply never be the transactional one, and it must be resolved,
    // never guessed (resolveColdIdentity refuses to invent a fallback).
    if (tx && domain === tx) {
      throw new MailStreamError(
        `Refusing to send cold mail on the transactional domain "${domain}". ` +
          "Cold campaigns send only from a dedicated cold domain (cold.*).",
      );
    }
    // Cold always bills to its own credentials — never the transactional key.
    return "MAILGUN_COLD_API_KEY";
  }

  if (cold && domain === cold) {
    throw new MailStreamError(
      `Refusing to send transactional mail on the cold domain "${domain}".`,
    );
  }
  return "MAILGUN_API_KEY";
}

class MailgunProvider implements MailProvider {
  readonly name = "mailgun";

  async send(msg: MailMessage): Promise<{ id: string }> {
    const keyVar = assertStreamDomain(msg);
    // A workspace key wins; otherwise the env variable for this stream.
    const key = msg.credentials?.apiKey?.trim() || process.env[keyVar];
    if (!key) {
      throw new Error(
        `No sending key for this stream — set it in Settings → Integrations or ${keyVar}.`,
      );
    }
    const base =
      process.env.MAILGUN_EU === "true"
        ? "https://api.eu.mailgun.net"
        : "https://api.mailgun.net";

    const form = new FormData();
    form.set("from", msg.from);
    form.set("to", msg.to);
    form.set("subject", msg.subject);
    form.set("html", msg.html);
    if (msg.text) form.set("text", msg.text);
    if (msg.replyTo) form.set("h:Reply-To", msg.replyTo);
    for (const a of msg.attachments ?? []) {
      form.append(
        "attachment",
        new Blob([new Uint8Array(a.content)], { type: a.contentType }),
        a.filename,
      );
    }

    const res = await fetch(`${base}/v3/${msg.domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`api:${key}`).toString("base64")}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Mailgun ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { id?: string };
    return { id: data.id ?? "" };
  }
}

class MockMailProvider implements MailProvider {
  readonly name = "mock";
  async send(msg: MailMessage): Promise<{ id: string }> {
    // The mock enforces the same stream/domain rule so a mis-routed cold send
    // fails in dev and in tests, not first in production.
    assertStreamDomain(msg);
    // eslint-disable-next-line no-console
    console.log(`[mail:mock] to=${msg.to} subject="${msg.subject}" (${msg.attachments?.length ?? 0} attachment)`);
    return { id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
}

let provider: MailProvider | null = null;
export function getMailProvider(): MailProvider {
  if (!provider) {
    const which = (process.env.MAIL_PROVIDER ?? "").toLowerCase();
    const useMailgun = which === "mailgun" || (which === "" && !!process.env.MAILGUN_API_KEY);
    provider = useMailgun ? new MailgunProvider() : new MockMailProvider();
  }
  return provider;
}
