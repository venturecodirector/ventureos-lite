"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Lang } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { MAX_ICP_SCORE } from "@/modules/leads/scoring";
import { listFieldDefsWith } from "@/modules/fields/store";
import { readValues, type FieldDef, type FieldValues } from "@/modules/fields/types";

/**
 * Lead detail for the pipeline card modal (spec §4.5).
 *
 * Everything here goes through getWorkspaceClient, so a lead id from another
 * workspace simply does not resolve (CLAUDE.md hard rule #1) — the modal cannot
 * be used to read or edit across tenants by guessing an id.
 */

export interface TimelineEntry {
  id: string;
  kind: "activity" | "message" | "call" | "meeting";
  label: string;
  detail: string;
  at: string;
}

export interface LeadDetail {
  id: string;
  contactName: string;
  title: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  language: Lang;
  notes: string;
  signals: string[];
  icpScore: number | null;
  maxScore: number;
  stage: string;
  stageReason: string | null;
  daysInStage: number;
  source: string;
  companyId: string | null;
  companyName: string;
  companyDomain: string;
  companyCity: string;
  companyTaxId: string;
  /** Relative path under FILES_DIR; served through the authenticated route. */
  avatarPath: string | null;
  /** The Haiku summary written at capture time (P1/1e). */
  personBrief: string | null;
  /** The About text the capture read, which the brief was written from. */
  bio: string | null;
  /** Owner-defined field definitions and this lead's values (P5/1). */
  customFieldDefs: FieldDef[];
  customFieldValues: FieldValues;
  timeline: TimelineEntry[];
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

export async function getLeadDetail(leadId: string): Promise<LeadDetail | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      company: true,
      activities: { orderBy: { at: "desc" }, take: 40 },
      messages: { orderBy: { createdAt: "desc" }, take: 20 },
      calls: { orderBy: { at: "desc" }, take: 20 },
      meetings: { orderBy: { scheduledAt: "desc" }, take: 20 },
    },
  });
  if (!lead) return null;

  const timeline: TimelineEntry[] = [
    ...lead.activities.map((a) => ({
      id: `a:${a.id}`,
      kind: "activity" as const,
      label: a.type.replace(/_/g, " "),
      detail: summarisePayload(a.payload),
      at: a.at.toISOString(),
    })),
    ...lead.messages.map((m) => ({
      id: `m:${m.id}`,
      kind: "message" as const,
      label: `${m.direction === "OUTBOUND" ? "sent" : "received"} · ${m.kind ?? m.channel.toLowerCase()}`,
      detail: m.body.slice(0, 160),
      at: (m.sentAt ?? m.createdAt).toISOString(),
    })),
    ...lead.calls.map((c) => ({
      id: `c:${c.id}`,
      kind: "call" as const,
      label: `call · ${c.outcome ?? "logged"}`,
      detail: c.note?.slice(0, 160) ?? "",
      at: c.at.toISOString(),
    })),
    ...lead.meetings.map((mt) => ({
      id: `mt:${mt.id}`,
      kind: "meeting" as const,
      label: `meeting · ${mt.type}`,
      detail: mt.outcome ?? "",
      at: mt.scheduledAt.toISOString(),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    id: lead.id,
    contactName: lead.contactName ?? "",
    title: lead.title ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    linkedinUrl: lead.linkedinUrl ?? "",
    language: lead.language,
    notes: lead.notes ?? "",
    signals: Array.isArray(lead.signals) ? (lead.signals as string[]) : [],
    icpScore: lead.icpScore,
    maxScore: MAX_ICP_SCORE,
    stage: lead.stage,
    stageReason: lead.stageReason,
    daysInStage: daysBetween(lead.stageEnteredAt, new Date()),
    source: lead.source,
    companyId: lead.companyId,
    companyName: lead.company?.name ?? "",
    companyDomain: lead.company?.domain ?? "",
    companyCity: lead.company?.city ?? "",
    companyTaxId: lead.company?.taxId ?? "",
    // Captured by the extension and stored since P1/1e, but never rendered —
    // which is why a captured photo appeared to vanish, and why the Haiku
    // person brief was being paid for and thrown away.
    avatarPath: lead.avatarPath ?? null,
    personBrief: lead.personBrief ?? null,
    bio: lead.bio ?? null,
    customFieldDefs: await listFieldDefsWith(db, "lead"),
    customFieldValues: readValues(lead.customFields),
    timeline: timeline.slice(0, 60),
  };
}

function summarisePayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const entries = Object.entries(payload as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`);
  return entries.join(" · ");
}

// ---------------------------------------------------------------------------
// inline editing
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  leadId: z.string().min(1),
  contactName: z.string().trim().max(160),
  title: z.string().trim().max(160),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(60),
  linkedinUrl: z.string().trim().max(500),
  language: z.enum(["HU", "EN"]),
  notes: z.string().max(8000),
  signals: z.array(z.string().trim().min(1).max(60)).max(20),
  company: z.object({
    name: z.string().trim().max(200),
    domain: z.string().trim().max(200),
    city: z.string().trim().max(120),
    taxId: z.string().trim().max(40),
  }),
});

export type UpdateLeadResult = { ok: true } | { ok: false; error: string };

/**
 * Save the editable fields. Validated server-side — the modal is a convenience,
 * not the boundary.
 *
 * Company edits are applied to the linked company record, which is shared by
 * every lead at that company; the adószám stays unique per workspace, so a
 * clash is refused rather than silently merging two companies.
 */
export async function updateLeadDetail(raw: unknown): Promise<UpdateLeadResult> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the values and try again." };
  const input = parsed.data;

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { id: true, companyId: true, email: true },
  });
  if (!lead) return { ok: false, error: "Lead not found." };

  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return { ok: false, error: "That email address does not look right." };
  }
  if (input.linkedinUrl && !/^https?:\/\//i.test(input.linkedinUrl)) {
    return { ok: false, error: "The LinkedIn URL should start with https://." };
  }

  // Company first: if the tax id clashes, nothing should have been saved yet.
  if (lead.companyId && input.company.name) {
    if (input.company.taxId) {
      const clash = await db.company.findFirst({
        where: { taxId: input.company.taxId, id: { not: lead.companyId } },
        select: { id: true, name: true },
      });
      if (clash) {
        return {
          ok: false,
          error: `Another company (${clash.name}) already has that adószám.`,
        };
      }
    }
    await db.company.update({
      where: { id: lead.companyId },
      data: {
        name: input.company.name,
        domain: input.company.domain || null,
        city: input.company.city || null,
        taxId: input.company.taxId || null,
      },
    });
  }

  await db.lead.update({
    where: { id: lead.id },
    data: {
      contactName: input.contactName || null,
      title: input.title || null,
      email: input.email || null,
      phone: input.phone || null,
      linkedinUrl: input.linkedinUrl || null,
      language: input.language,
      notes: input.notes || null,
      signals: input.signals,
      lastActivityAt: new Date(),
    },
  });

  await db.activity.create({
    data: { workspaceId, leadId: lead.id, type: "lead_edited", byUserId: userId },
  });

  revalidatePath("/pipeline");
  revalidatePath("/leads");
  return { ok: true };
}

/**
 * ICP score override from the modal. Mirrors modules/leads/actions.overrideScore
 * — bounded, and audit-logged with the reason (hard rule #8), because the score
 * gates entry to Contacted (hard rule #5) and changing it by hand is a decision
 * someone should be able to account for later.
 */
export async function overrideScoreFromDetail(
  raw: unknown,
): Promise<{ ok: true; icpScore: number } | { ok: false; error: string }> {
  const parsed = z
    .object({
      leadId: z.string().min(1),
      score: z.coerce.number().int().min(0).max(MAX_ICP_SCORE),
      reason: z.string().trim().min(3).max(500),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Pick a score and give a short reason." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: parsed.data.leadId },
    select: { icpScore: true },
  });
  if (!lead) return { ok: false, error: "Lead not found." };

  await db.lead.update({
    where: { id: parsed.data.leadId },
    data: { icpScore: parsed.data.score },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "lead.score_override",
      entityType: "Lead",
      entityId: parsed.data.leadId,
      meta: { from: lead.icpScore, to: parsed.data.score, reason: parsed.data.reason },
    },
  });
  revalidatePath("/pipeline");
  revalidatePath("/leads");
  return { ok: true, icpScore: parsed.data.score };
}

/** Users who can be shown as timeline actors. */
export async function getActorNames(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const users = await prismaUnsafe.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}
