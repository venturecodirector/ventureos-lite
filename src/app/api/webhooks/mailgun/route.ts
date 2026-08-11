import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { verifyMailgunSignature } from "@/modules/mail/signature";
import { mapMailgunEvent } from "@/modules/mail/events";
import { suppressAddress, evaluateCircuitBreaker } from "@/modules/campaigns/send";

/**
 * Mailgun EU webhook (spec §4.11): delivery/open → lead timeline; bounces,
 * complaints, unsubscribes → suppression list. Public but signature-verified.
 */
interface MailgunWebhook {
  signature?: { timestamp?: string; token?: string; signature?: string };
  "event-data"?: {
    event?: string;
    recipient?: string;
    message?: { headers?: { "message-id"?: string } };
  };
}

export async function POST(req: Request) {
  const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!signingKey) return new Response("Webhooks not configured", { status: 503 });

  let payload: MailgunWebhook;
  try {
    payload = (await req.json()) as MailgunWebhook;
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  const sig = payload.signature ?? {};
  if (
    !verifyMailgunSignature(
      signingKey,
      String(sig.timestamp ?? ""),
      String(sig.token ?? ""),
      String(sig.signature ?? ""),
    )
  ) {
    return new Response("Invalid signature", { status: 403 });
  }

  const ev = payload["event-data"] ?? {};
  const event = String(ev.event ?? "");
  const recipient = String(ev.recipient ?? "");
  const messageId = String(ev.message?.headers?.["message-id"] ?? "");
  const mapped = mapMailgunEvent(event);

  const log = await prismaUnsafe.emailLog.findFirst({
    where: messageId
      ? { OR: [{ mailgunId: { contains: messageId } }, { to: recipient }] }
      : { to: recipient },
    orderBy: { at: "desc" },
  });

  if (log) {
    if (mapped.status) {
      await prismaUnsafe.emailLog.update({ where: { id: log.id }, data: { status: mapped.status } });
    }
    if ((event === "delivered" || event === "opened") && log.leadId) {
      await prismaUnsafe.activity.create({
        data: {
          workspaceId: log.workspaceId,
          leadId: log.leadId,
          type: `email_${event}`,
          payload: { to: recipient },
        },
      });
    }
    if (mapped.suppress && recipient) {
      // Shared suppression: also flips matching campaign recipients (spec §4.16).
      const db = getWorkspaceClient(log.workspaceId);
      await suppressAddress(db, log.workspaceId, recipient, event);
    }
    // Bounce → mark cold-campaign recipients + trip the circuit breaker.
    if (event === "failed" && recipient) {
      const db = getWorkspaceClient(log.workspaceId);
      const recips = await db.campaignRecipient.findMany({
        where: { email: recipient },
        select: { campaignId: true },
      });
      if (recips.length) {
        await db.campaignRecipient.updateMany({ where: { email: recipient }, data: { bounced: true } });
        for (const cid of [...new Set(recips.map((r) => r.campaignId))]) {
          await evaluateCircuitBreaker(db, cid);
        }
      }
    }
  }

  return new Response("ok", { status: 200 });
}
