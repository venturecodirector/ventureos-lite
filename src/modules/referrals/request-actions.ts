"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { conversion, type ReferralConversion } from "./request";

/**
 * What happened to the asks (playbook-v4 P13/3).
 *
 * Tracked because the point of asking is finding out whether asking works. An
 * engine that only counts its own drafts tells you it is busy.
 */
export interface ReferralRequestRow {
  id: string;
  leadId: string | null;
  leadName: string;
  status: string;
  messageId: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface ReferralRequestView {
  rows: ReferralRequestRow[];
  conversion: ReferralConversion;
}

export async function listReferralRequests(): Promise<ReferralRequestView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.referralRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      leadId: true,
      status: true,
      messageId: true,
      createdAt: true,
      respondedAt: true,
      companyId: true,
    },
  });

  const leadIds = rows.map((r) => r.leadId).filter((v): v is string => !!v);
  const leads = leadIds.length
    ? await db.lead.findMany({
        where: { id: { in: leadIds } },
        select: { id: true, contactName: true, company: { select: { name: true } } },
      })
    : [];
  const nameById = new Map(
    leads.map((l) => [l.id, l.company?.name ?? l.contactName ?? "ügyfél"]),
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      leadName: r.leadId ? (nameById.get(r.leadId) ?? "ügyfél") : "ügyfél",
      status: r.status,
      messageId: r.messageId,
      createdAt: r.createdAt.toISOString(),
      respondedAt: r.respondedAt?.toISOString() ?? null,
    })),
    conversion: conversion(rows),
  };
}

const setSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["drafted", "sent", "responded", "produced"]),
});

export async function setReferralRequestStatus(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Ismeretlen állapot." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  await db.referralRequest.update({
    where: { id: parsed.data.id },
    data: {
      status: parsed.data.status,
      // Stamped the first time somebody says the client came back, so the
      // "how long does an answer take" question stays answerable later.
      ...(parsed.data.status === "responded" || parsed.data.status === "produced"
        ? { respondedAt: new Date() }
        : {}),
    },
  });
  revalidatePath("/referrers");
  return { ok: true };
}
