import { createHmac } from "node:crypto";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { normalizeEmail } from "@/modules/leads/dedupe";
import { markReplied, suppressAddress } from "@/modules/campaigns/send";

/**
 * Mailgun inbound route (spec §4.16). Cold-email replies are forwarded here,
 * matched to the campaign recipient (→ lead + workspace), written into the Inbox
 * as an INBOUND message (same qualification flow), and the sequence is stopped
 * (stop-on-reply). An unsubscribe/objection reply also suppresses the address.
 */
function verify(timestamp: string, token: string, signature: string): boolean {
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!key) return true; // dev: accept when unconfigured
  const expected = createHmac("sha256", key).update(timestamp + token).digest("hex");
  return expected === signature;
}

function isObjection(body: string): boolean {
  return /\b(unsubscribe|leiratkoz|ne (küldj|irj)|stop|remove me|töröl)/i.test(body);
}

export async function POST(req: Request) {
  /**
   * PARSE DEFENSIVELY. This endpoint is public by necessity — Mailgun has no way
   * to authenticate before we read the signature out of the form — so anything on
   * the internet can POST to it.
   *
   * It used to call `req.formData()` as its very first statement, with no
   * content-type check and no try/catch, so any POST carrying JSON or an empty
   * body raised an unhandled TypeError:
   *
   *     TypeError: Content-Type was not one of "multipart/form-data" or
   *     "application/x-www-form-urlencoded"
   *
   * 29 of those in 48 hours of production logs. Harmless to the data — nothing had
   * been read yet — but it is an unhandled throw on a public route, which means
   * log noise that buries real errors and a free way to fill the disk.
   *
   * A malformed request now gets a cheap, quiet refusal.
   */
  const contentType = req.headers.get("content-type") ?? "";
  if (!/multipart\/form-data|application\/x-www-form-urlencoded/i.test(contentType)) {
    return new Response("expected form-encoded body", { status: 415 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // A declared form content-type with a body that is not one.
    return new Response("malformed form body", { status: 400 });
  }
  const get = (k: string) => (form.get(k) ? String(form.get(k)) : "");

  if (!verify(get("timestamp"), get("token"), get("signature"))) {
    return new Response("invalid signature", { status: 406 });
  }

  const sender = normalizeEmail(get("sender") || get("from"));
  const body = get("stripped-text") || get("body-plain") || "";
  if (!sender) return new Response("ok", { status: 200 });

  // Match the sender to a campaign recipient → its lead + workspace.
  const recipient = await prismaUnsafe.campaignRecipient.findFirst({
    where: { email: sender },
    select: { workspaceId: true, leadId: true, email: true },
    orderBy: { sentAt: "desc" },
  });
  if (!recipient?.leadId) return new Response("ok", { status: 200 });

  const db = getWorkspaceClient(recipient.workspaceId);
  const now = Date.now();

  await db.message.create({
    data: {
      workspaceId: recipient.workspaceId,
      leadId: recipient.leadId,
      direction: "INBOUND",
      channel: "COLD_EMAIL",
      kind: "reply",
      body,
      status: "SENT",
    },
  });
  await db.lead.update({ where: { id: recipient.leadId }, data: { lastActivityAt: new Date(now) } });

  // Stop-on-reply across the recipient's campaigns.
  await markReplied(db, recipient.leadId, now);

  // Any objection → instant suppress across all campaigns.
  if (isObjection(body)) {
    await suppressAddress(db, recipient.workspaceId, recipient.email, "objection");
  }

  return new Response("ok", { status: 200 });
}
