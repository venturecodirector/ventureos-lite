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
import { getMailProvider } from "@/modules/mail/provider";
import { resolveSendingIdentity } from "@/modules/mail/identity";
import {
  EMPTY_QUALIFICATION,
  canQualify,
  answeredCount,
  type Qualification,
  type QualItem,
} from "./qualification";
import { detectMoneyTalk, escalationReason } from "./escalation";

export interface ThreadSummary {
  leadId: string;
  name: string;
  company: string;
  snippet: string;
  unread: boolean;
  escalated: boolean;
}

export interface ThreadMessage {
  id: string;
  direction: string;
  body: string;
  at: string;
  analysis: ReplyAnalysis | null;
}

export interface ThreadView {
  leadId: string;
  name: string;
  company: string;
  escalated: boolean;
  qualification: Qualification;
  answered: number;
  canQualify: boolean;
  messages: ThreadMessage[];
  latestAnalysis: ReplyAnalysis | null;
}

function asAnalysis(v: unknown): ReplyAnalysis | null {
  const p = replyAnalysisSchema.safeParse(v);
  return p.success ? p.data : null;
}

export async function listThreads(): Promise<ThreadSummary[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const leads = await db.lead.findMany({
    where: { messages: { some: {} } },
    include: {
      company: { select: { name: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { lastActivityAt: "desc" },
  });
  return leads.map((l) => {
    const last = l.messages[0];
    return {
      leadId: l.id,
      name: l.contactName ?? l.company?.name ?? "Unnamed lead",
      company: l.company?.name ?? "—",
      snippet: (last?.body ?? "").replace(/\s+/g, " ").slice(0, 80),
      unread: last?.direction === "INBOUND",
      escalated: !!l.escalatedAt,
    };
  });
}

export async function getThread(leadId: string): Promise<ThreadView | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      company: { select: { name: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!lead) return null;

  const qualification = { ...EMPTY_QUALIFICATION, ...((lead.qualification ?? {}) as Partial<Qualification>) };
  const messages: ThreadMessage[] = lead.messages.map((m) => ({
    id: m.id,
    direction: m.direction,
    body: m.body,
    at: m.createdAt.toISOString(),
    analysis: asAnalysis(m.analysis),
  }));
  const latestInbound = [...lead.messages].reverse().find((m) => m.direction === "INBOUND");

  return {
    leadId: lead.id,
    name: lead.contactName ?? lead.company?.name ?? "Unnamed lead",
    company: lead.company?.name ?? "—",
    escalated: !!lead.escalatedAt,
    qualification,
    answered: answeredCount(qualification),
    canQualify: canQualify(qualification),
    messages,
    latestAnalysis: asAnalysis(latestInbound?.analysis),
  };
}

async function notifyOwners(workspaceId: string, leadName: string, reason: string): Promise<void> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { mailgunConfig: true },
  });
  const identity = resolveSendingIdentity(ws?.mailgunConfig);
  const owners = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: "OWNER" },
    include: { user: { select: { email: true } } },
  });
  for (const owner of owners) {
    await getMailProvider().send({
      domain: identity.domain,
      to: owner.user.email,
      from: identity.from,
      replyTo: identity.replyTo || undefined,
      subject: `Price escalation — ${leadName}`,
      html: `<p>${leadName} mentioned ${reason}. Money-talk drafting is locked for this thread — please take over.</p>`,
    });
  }
}

const inboundSchema = z.object({ leadId: z.string().min(1), body: z.string().min(1) });

export async function logInboundReply(
  raw: unknown,
): Promise<{ analysis: ReplyAnalysis | null; escalated: boolean }> {
  const input = inboundSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { contactName: true, company: { select: { name: true } } },
  });

  // Prior context (before this reply) for the analysis.
  const prior = await db.message.findMany({
    where: { leadId: input.leadId },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { direction: true, body: true },
  });
  const history = prior
    .reverse()
    .map((m) => `${m.direction === "INBOUND" ? "Prospect" : "BDR"}: ${m.body}`)
    .join("\n");

  const msg = await db.message.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      direction: "INBOUND",
      channel: "LINKEDIN",
      status: "SENT",
      body: input.body,
    },
  });

  // Haiku analysis — budget-checked, best-effort (analysis stays null if capped).
  let analysis: ReplyAnalysis | null = null;
  try {
    const { data } = await callClaude({
      useCase: "reply_analysis",
      workspaceId,
      system: REPLY_ANALYSIS_SYSTEM,
      messages: [{ role: "user", content: buildReplyMessage(history, input.body) }],
      schema: replyAnalysisSchema,
    });
    analysis = data as ReplyAnalysis;
    await db.message.update({ where: { id: msg.id }, data: { analysis } });
  } catch {
    /* budget cap / parse failure — leave analysis null */
  }

  // Escalation: price/proposal/contract mentions flag + notify + lock.
  const reason = escalationReason(input.body);
  let escalated = false;
  if (reason) {
    await db.lead.update({ where: { id: input.leadId }, data: { escalatedAt: new Date() } });
    await db.activity.create({
      data: { workspaceId, leadId: input.leadId, type: "price_escalation", payload: { reason } },
    });
    try {
      await notifyOwners(workspaceId, lead?.contactName ?? lead?.company?.name ?? "a lead", reason);
    } catch {
      /* notify best-effort */
    }
    escalated = true;
  }

  await db.lead.update({ where: { id: input.leadId }, data: { lastActivityAt: new Date() } });
  revalidatePath("/inbox");
  return { analysis, escalated };
}

const outboundSchema = z.object({ leadId: z.string().min(1), body: z.string().min(1) });

export async function logOutboundReply(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = outboundSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { escalatedAt: true },
  });
  if (lead?.escalatedAt && detectMoneyTalk(input.body)) {
    return { ok: false, error: "Money-talk is locked — this thread is escalated to the Owner." };
  }

  await db.message.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      direction: "OUTBOUND",
      channel: "LINKEDIN",
      status: "SENT",
      body: input.body,
      humanEdited: true,
    },
  });
  await db.lead.update({ where: { id: input.leadId }, data: { lastActivityAt: new Date() } });
  revalidatePath("/inbox");
  return { ok: true };
}

const qualSchema = z.object({
  leadId: z.string().min(1),
  item: z.enum(["authority", "history", "budget", "timeline"]),
  value: z.boolean(),
});

export async function setQualification(
  raw: unknown,
): Promise<{ qualification: Qualification; canQualify: boolean }> {
  const input = qualSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { qualification: true },
  });
  const current = (lead?.qualification ?? {}) as Partial<Qualification>;
  const next: Qualification = {
    ...EMPTY_QUALIFICATION,
    ...current,
    [input.item as QualItem]: input.value,
  };
  await db.lead.update({ where: { id: input.leadId }, data: { qualification: next } });
  revalidatePath("/inbox");
  revalidatePath("/pipeline");
  return { qualification: next, canQualify: canQualify(next) };
}
