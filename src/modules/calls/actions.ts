"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { callbackChipDate, isCallbackDue, type CallbackChip } from "./schedule";
import { enqueueCallback, cancelCallback } from "./jobs";

const OUTCOMES = [
  "NO_ANSWER",
  "CALLBACK_REQUESTED",
  "INTERESTED",
  "NOT_INTERESTED",
  "WRONG_NUMBER",
] as const;

const logSchema = z.object({
  leadId: z.string().min(1),
  outcome: z.enum(OUTCOMES),
  note: z.string().optional(),
  duration: z.number().int().optional(),
  callbackChip: z.enum(["tomorrow_9", "thu_14", "next_mon_9"]).optional(),
  callbackAt: z.string().optional(), // ISO, from the custom picker
});

export interface DueCallback {
  callId: string;
  leadId: string;
  name: string;
  at: string; // ISO
  due: boolean;
  note: string | null;
}

export interface RecentCall {
  callId: string;
  name: string;
  outcome: string;
  note: string | null;
  at: string; // ISO
}

function leadName(lead: {
  contactName: string | null;
  company: { name: string } | null;
}): string {
  return lead.contactName ?? lead.company?.name ?? "Unnamed lead";
}

export async function logCall(raw: unknown): Promise<{ callId: string }> {
  const input = logSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const now = new Date();

  const callbackAt = input.callbackChip
    ? callbackChipDate(input.callbackChip as CallbackChip, now)
    : input.callbackAt
      ? new Date(input.callbackAt)
      : null;

  const call = await db.call.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      outcome: input.outcome,
      note: input.note,
      duration: input.duration,
      callbackAt,
      byUserId: userId,
    },
  });

  // Calls are first-class activities (feed funnel, Signal Engine, win/loss).
  await db.activity.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      type: "call",
      byUserId: userId,
      payload: { outcome: input.outcome, note: input.note ?? null, callId: call.id },
    },
  });
  await db.lead.update({
    where: { id: input.leadId },
    data: { lastActivityAt: now },
  });

  if (callbackAt) {
    await enqueueCallback(
      { callId: call.id, leadId: input.leadId, workspaceId },
      callbackAt,
    );
  }

  revalidatePath("/calls");
  return { callId: call.id };
}

export async function listDueCallbacks(): Promise<DueCallback[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const now = new Date();
  const rows = await db.call.findMany({
    where: { callbackAt: { not: null }, callbackDoneAt: null },
    orderBy: { callbackAt: "asc" },
    include: {
      lead: { select: { contactName: true, company: { select: { name: true } } } },
    },
  });
  return rows.map((c) => ({
    callId: c.id,
    leadId: c.leadId,
    name: leadName(c.lead),
    at: c.callbackAt!.toISOString(),
    due: isCallbackDue(c.callbackAt!, now),
    note: c.note,
  }));
}

export async function listRecentCalls(): Promise<RecentCall[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.call.findMany({
    orderBy: { at: "desc" },
    take: 20,
    include: {
      lead: { select: { contactName: true, company: { select: { name: true } } } },
    },
  });
  return rows.map((c) => ({
    callId: c.id,
    name: leadName(c.lead),
    outcome: c.outcome,
    note: c.note,
    at: c.at.toISOString(),
  }));
}

export async function completeCallback(callId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.call.update({
    where: { id: callId },
    data: { callbackDoneAt: new Date() },
  });
  await cancelCallback(callId);
  revalidatePath("/calls");
  return { ok: true };
}
