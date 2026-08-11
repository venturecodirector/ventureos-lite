/**
 * Mail provider adapter (spec §4.11). Mailgun EU in production; a mock in dev.
 * Transactional only — no bulk/campaign sending in Lite (CLAUDE.md hard rule #2).
 */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  domain: string;
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

class MailgunProvider implements MailProvider {
  readonly name = "mailgun";

  async send(msg: MailMessage): Promise<{ id: string }> {
    const key = process.env.MAILGUN_API_KEY;
    if (!key) throw new Error("MAILGUN_API_KEY is not set");
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
