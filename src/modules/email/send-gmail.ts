"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { GmailProvider } from "./gmail";
import { MailAuthError, type MailCredentials } from "./provider";
import { sanitizeEmailHtml, htmlToText } from "./sanitize";
import { escalationReason } from "@/modules/inbox/escalation";
import { isRecipientSuppressed } from "@/modules/mail/suppression";

/**
 * Replying to a thread from inside the app (playbook-v2 P2d).
 *
 * Sent through the USER'S OWN Gmail, deliberately: the reply then lands in
 * their real Sent folder, threads correctly for the recipient, and carries the
 * personal identity the conversation already has. A transactional relay would
 * break all three.
 *
 * THIS FILE MUST NEVER BE IMPORTED BY THE CAMPAIGN MODULES, and imports none of
 * them. Cold mail goes out on the Mailgun cold domain or it does not go out at
 * all — an import-graph test enforces the separation, because a runtime flag
 * can be forgotten in a new call site and a missing import cannot.
 */
const replySchema = z.object({
  threadId: z.string().min(1),
  to: z.array(z.string().email()).min(1).max(10),
  cc: z.array(z.string().email()).max(10).optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  /** The operator has read the escalation warning and is sending anyway. */
  acknowledgeEscalation: z.boolean().optional(),
});

export type SendReplyResult =
  | { ok: true; messageId: string }
  | { ok: false; error: "escalated" | "suppressed" | "not_found" | "reconnect" | "failed"; message: string };

export async function sendThreadReply(raw: unknown): Promise<SendReplyResult> {
  const input = replySchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const thread = await db.emailThread.findUnique({
    where: { id: input.threadId },
    include: {
      account: true,
      messages: { orderBy: { sentAt: "desc" }, take: 1 },
    },
  });
  if (!thread) {
    return { ok: false, error: "not_found", message: "That conversation is gone." };
  }

  // The mailbox belongs to a person. Sending from someone else's connected
  // account would put their name on words they never wrote.
  if (thread.account.userId !== userId) {
    return {
      ok: false,
      error: "not_found",
      message: "That conversation belongs to another user's mailbox.",
    };
  }

  // Money talk locks the thread (spec §4.7). A reply that mentions price,
  // proposal or contract needs an explicit acknowledgement — the lock exists
  // so a quick answer about money is a decision, not a reflex.
  const reason = escalationReason(input.body);
  if (reason && !input.acknowledgeEscalation) {
    return {
      ok: false,
      error: "escalated",
      message: `This mentions ${reason}. Confirm before sending — money talk is escalated to the Owner.`,
    };
  }

  const suppressions = await db.suppression.findMany({ select: { address: true } });
  for (const recipient of input.to) {
    if (isRecipientSuppressed(recipient, suppressions.map((s) => s.address))) {
      return {
        ok: false,
        error: "suppressed",
        message: `${recipient} has asked not to be contacted.`,
      };
    }
  }

  const credential = thread.account.credentialId
    ? await prismaUnsafe.googleCredential.findUnique({
        where: { id: thread.account.credentialId },
      })
    : null;
  if (!credential) {
    return { ok: false, error: "reconnect", message: "Reconnect the mailbox to send." };
  }

  const creds: MailCredentials = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiryDate: credential.expiryDate,
  };

  // The operator's text is escaped into simple HTML rather than passed through:
  // whatever they typed is content, never markup.
  const bodyHtml = sanitizeEmailHtml(
    input.body
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`)
      .join(""),
  ).html;

  try {
    const { providerMessageId, refreshed } = await new GmailProvider().sendReply(creds, {
      providerThreadId: thread.providerThreadId,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      bodyText: input.body,
      bodyHtml,
    });

    if (refreshed?.accessToken) {
      await prismaUnsafe.googleCredential.update({
        where: { id: credential.id },
        data: {
          accessToken: refreshed.accessToken,
          ...(refreshed.expiryDate ? { expiryDate: refreshed.expiryDate } : {}),
        },
      });
    }

    // Written locally too, so the thread reads correctly before the next sync
    // pass catches up — a reply that vanishes for two minutes looks like a
    // failure.
    await db.emailMessage.create({
      data: {
        workspaceId,
        threadId: thread.id,
        providerMessageId,
        direction: "OUTBOUND",
        fromAddress: thread.account.accountEmail,
        toAddresses: input.to,
        ccAddresses: input.cc ?? [],
        subject: input.subject,
        snippet: htmlToText(bodyHtml).slice(0, 200),
        bodyHtml,
        bodyText: input.body,
        sentAt: new Date(),
      },
    });
    await db.emailThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: new Date(), messageCount: { increment: 1 }, unread: false },
    });

    if (thread.leadId) {
      await db.activity.create({
        data: {
          workspaceId,
          leadId: thread.leadId,
          type: "email_reply_sent",
          byUserId: userId,
          payload: { to: input.to, subject: input.subject, escalated: !!reason },
        },
      });
    }

    revalidatePath("/inbox");
    return { ok: true, messageId: providerMessageId };
  } catch (e) {
    if (e instanceof MailAuthError) {
      await prismaUnsafe.mailAccount.update({
        where: { id: thread.account.id },
        data: { health: "reconnect_needed", lastError: e.message },
      });
      return { ok: false, error: "reconnect", message: "Reconnect the mailbox to send." };
    }
    return { ok: false, error: "failed", message: (e as Error).message.slice(0, 200) };
  }
}
