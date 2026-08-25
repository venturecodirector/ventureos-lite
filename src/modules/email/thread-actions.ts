"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { callClaude } from "@/lib/ai/call-claude";
import {
  REPLY_ANALYSIS_SYSTEM,
  replyAnalysisSchema,
  buildReplyMessage,
  type ReplyAnalysis,
} from "@/lib/ai/prompts/reply-analysis";
import { escalationReason } from "@/modules/inbox/escalation";
import { normalizeAddress } from "./matching";

/**
 * Synced correspondence on the lead timeline (playbook-v2 P2c).
 *
 * The rule that shapes this file: reply analysis costs a Claude call, so it
 * fires when a HUMAN OPENS an unread inbound message — never while syncing.
 * A 90-day backfill of two mailboxes would otherwise be thousands of calls in
 * a burst, which is exactly what the budget rule exists to prevent.
 */
export interface ThreadMessageView {
  id: string;
  direction: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  snippet: string;
  bodyHtml: string;
  bodyText: string;
  sentAt: string;
  hasAttachments: boolean;
  attachments: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
  analyzed: boolean;
  /**
   * Open/click feedback on a message WE sent (playbook-v3 P9/1).
   *
   * Null when the message was sent without tracking, or came from the other
   * side — which is most of them.
   */
  tracking: {
    opens: number;
    lastOpenAt: string | null;
    clicks: Array<{ url: string; at: string }>;
  } | null;
}

export interface EmailThreadView {
  id: string;
  subject: string | null;
  matchType: string;
  lastMessageAt: string;
  unread: boolean;
  messageCount: number;
  accountEmail: string;
  messages: ThreadMessageView[];
}

function toMessageView(m: {
  id: string;
  direction: string;
  fromAddress: string;
  toAddresses: unknown;
  subject: string | null;
  snippet: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  sentAt: Date;
  hasAttachments: boolean;
  attachments: unknown;
  analyzedAt: Date | null;
  trackingId?: string | null;
  trackEvents?: Array<{ kind: string; url: string | null; at: Date }>;
}): ThreadMessageView {
  return {
    id: m.id,
    direction: m.direction,
    fromAddress: m.fromAddress,
    toAddresses: Array.isArray(m.toAddresses) ? (m.toAddresses as string[]) : [],
    subject: m.subject,
    snippet: m.snippet ?? "",
    bodyHtml: m.bodyHtml ?? "",
    bodyText: m.bodyText ?? "",
    sentAt: m.sentAt.toISOString(),
    hasAttachments: m.hasAttachments,
    attachments: Array.isArray(m.attachments)
      ? (m.attachments as Array<{ filename: string; mimeType: string; sizeBytes: number }>)
      : [],
    analyzed: m.analyzedAt !== null,
    tracking: m.trackingId
      ? (() => {
          const events = m.trackEvents ?? [];
          const opens = events.filter((e) => e.kind === "open");
          return {
            opens: opens.length,
            lastOpenAt: opens[opens.length - 1]?.at.toISOString() ?? null,
            clicks: events
              .filter((e) => e.kind === "click" && e.url)
              .map((e) => ({ url: e.url!, at: e.at.toISOString() })),
          };
        })()
      : null,
  };
}

/** Threads for one lead, newest first. */
export async function listLeadThreads(leadId: string): Promise<EmailThreadView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const threads = await db.emailThread.findMany({
    where: { leadId },
    orderBy: { lastMessageAt: "desc" },
    include: {
      account: { select: { accountEmail: true } },
      messages: {
        orderBy: { sentAt: "asc" },
        // Open/click feedback rides along with the thread (P9/1) rather than
        // costing one query per message.
        include: { trackEvents: { orderBy: { at: "asc" } } },
      },
    },
  });

  return threads.map((t) => ({
    id: t.id,
    subject: t.subject,
    matchType: t.matchType,
    lastMessageAt: t.lastMessageAt.toISOString(),
    unread: t.unread,
    messageCount: t.messageCount,
    accountEmail: t.account.accountEmail,
    messages: t.messages.map(toMessageView),
  }));
}

/**
 * Open a message: mark it read and, if it is an unread INBOUND one, analyse it.
 *
 * This is the ONLY place email triggers a Claude call. It is deliberately tied
 * to a human opening something rather than to arrival, so the cost tracks
 * attention rather than volume.
 */
export async function openMessage(
  messageId: string,
): Promise<{ analysis: ReplyAnalysis | null; escalated: boolean }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const message = await db.emailMessage.findUnique({
    where: { id: messageId },
    include: { thread: { select: { id: true, leadId: true, unread: true } } },
  });
  if (!message) return { analysis: null, escalated: false };

  await db.emailThread.update({
    where: { id: message.threadId },
    data: { unread: false },
  });

  // Outbound mail is ours, already-analysed mail is done, and an unmatched
  // thread has no lead to analyse against. None of the three is worth a call.
  if (message.direction !== "INBOUND" || message.analyzedAt || !message.thread.leadId) {
    revalidatePath("/inbox");
    return { analysis: null, escalated: false };
  }

  const leadId = message.thread.leadId;
  const body = message.bodyText || message.snippet || "";

  const prior = await db.emailMessage.findMany({
    where: { threadId: message.threadId, sentAt: { lt: message.sentAt } },
    orderBy: { sentAt: "desc" },
    take: 6,
    select: { direction: true, bodyText: true, snippet: true },
  });
  const history = prior
    .reverse()
    .map(
      (m) =>
        `${m.direction === "INBOUND" ? "Prospect" : "BDR"}: ${m.bodyText || m.snippet || ""}`,
    )
    .join("\n");

  let analysis: ReplyAnalysis | null = null;
  try {
    const { data } = await callClaude({
      useCase: "reply_analysis",
      workspaceId,
      system: REPLY_ANALYSIS_SYSTEM,
      messages: [{ role: "user", content: buildReplyMessage(history, body) }],
      schema: replyAnalysisSchema,
    });
    analysis = data as ReplyAnalysis;
  } catch {
    /* budget cap or parse failure — the message still opens */
  }

  // Stamped whether or not the call succeeded: a budget-capped message must
  // not re-attempt on every open, or one lead can drain a day's budget by
  // being clicked repeatedly.
  await db.emailMessage.update({
    where: { id: message.id },
    data: { analyzedAt: new Date() },
  });

  const reason = escalationReason(body);
  let escalated = false;
  if (reason) {
    await db.lead.update({ where: { id: leadId }, data: { escalatedAt: new Date() } });
    await db.activity.create({
      data: {
        workspaceId,
        leadId,
        type: "price_escalation",
        payload: { reason, source: "email" },
      },
    });
    escalated = true;
  }

  revalidatePath("/inbox");
  return { analysis, escalated };
}

// ---------------------------------------------------------------------------
// Unmatched threads
// ---------------------------------------------------------------------------

export interface UnmatchedThreadView {
  id: string;
  subject: string | null;
  participants: string[];
  lastMessageAt: string;
  snippet: string;
}

export async function listUnmatchedThreads(): Promise<UnmatchedThreadView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const threads = await db.emailThread.findMany({
    where: { leadId: null },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    include: { messages: { orderBy: { sentAt: "desc" }, take: 1 } },
  });

  return threads.map((t) => ({
    id: t.id,
    subject: t.subject,
    participants: [...new Set(t.messages.map((m) => m.fromAddress))],
    lastMessageAt: t.lastMessageAt.toISOString(),
    snippet: t.messages[0]?.snippet ?? "",
  }));
}

const linkSchema = z.object({
  threadId: z.string().min(1),
  leadId: z.string().min(1),
});

/**
 * Link an unmatched thread to a lead — and remember the address.
 *
 * The AddressLink is what makes this a one-time correction rather than a chore:
 * without it the same person writing from the same address needs linking again
 * every time they reply.
 */
export async function linkThreadToLead(raw: unknown): Promise<{ ok: true; learned: number }> {
  const input = linkSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const thread = await db.emailThread.findUnique({
    where: { id: input.threadId },
    include: { messages: { select: { fromAddress: true, toAddresses: true } } },
  });
  if (!thread) return { ok: true, learned: 0 };

  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { id: true, companyId: true, email: true },
  });
  if (!lead) return { ok: true, learned: 0 };

  await db.emailThread.update({
    where: { id: thread.id },
    data: { leadId: lead.id, companyId: lead.companyId, matchType: "manual" },
  });

  // Learn every counterpart address on the thread, not just the sender: a
  // colleague who replies from a second address should match next time too.
  const own = await prismaUnsafe.mailAccount.findMany({
    where: { workspaceId },
    select: { accountEmail: true },
  });
  const self = new Set(own.map((a) => normalizeAddress(a.accountEmail)));

  const addresses = new Set<string>();
  for (const m of thread.messages) {
    addresses.add(normalizeAddress(m.fromAddress));
    for (const to of Array.isArray(m.toAddresses) ? (m.toAddresses as string[]) : []) {
      addresses.add(normalizeAddress(to));
    }
  }

  let learned = 0;
  for (const email of addresses) {
    if (!email.includes("@") || self.has(email)) continue;
    await db.addressLink.upsert({
      where: { workspaceId_email: { workspaceId, email } },
      create: { workspaceId, email, leadId: lead.id, companyId: lead.companyId, createdBy: userId },
      update: { leadId: lead.id, companyId: lead.companyId },
    });
    learned += 1;
  }

  revalidatePath("/inbox");
  return { ok: true, learned };
}
