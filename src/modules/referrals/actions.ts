"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { ReferrerKind, LeadSource } from "@prisma/client";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { getReferrerLedger, type LedgerRow } from "./data";

// ---- referrer CRUD ---------------------------------------------------------

const referrerSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["PERSON", "COMPANY"]),
  linkedCompanyId: z.string().optional().nullable(),
});

export interface ReferrerOption {
  id: string;
  name: string;
  kind: "PERSON" | "COMPANY";
  linkedCompany: string | null;
}

export async function listReferrers(): Promise<ReferrerOption[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.referrer.findMany({
    include: { linkedCompany: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    linkedCompany: r.linkedCompany?.name ?? null,
  }));
}

export async function createReferrer(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = referrerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "A referrer name and type are required." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const r = await db.referrer.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      kind: parsed.data.kind as ReferrerKind,
      linkedCompanyId: parsed.data.linkedCompanyId || undefined,
    },
  });
  revalidatePath("/referrers");
  return { ok: true, id: r.id };
}


// ---- lead source + referrer assignment (editable) --------------------------

const assignSchema = z.object({
  leadId: z.string().min(1),
  source: z.enum(["PROSPECTOR", "LINKEDIN", "MANUAL", "REFERRAL", "COLD_EMAIL"]),
  referrerId: z.string().optional().nullable(),
});

export async function setLeadReferrer(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = assignSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid source/referrer." };
  const { source, referrerId, leadId } = parsed.data;
  // A referrer only makes sense for referral-sourced leads.
  if (source !== "REFERRAL" && referrerId) {
    return { ok: false, error: "Only referral-sourced leads can carry a referrer." };
  }
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.lead.update({
    where: { id: leadId },
    data: {
      source: source as LeadSource,
      referrerId: source === "REFERRAL" ? referrerId || null : null,
    },
  });
  revalidatePath("/leads");
  revalidatePath("/referrers");
  return { ok: true };
}

// ---- ledger read -----------------------------------------------------------

export async function getLedger(): Promise<LedgerRow[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  return getReferrerLedger(db);
}
