"use server";

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner, requireGrant } from "@/lib/authz";
import { enqueueLeadErasure } from "./jobs";
import { buildExportZip } from "./export";
import { parseRetention, type RetentionPolicy } from "./retention";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

// ---- lead erasure (Owner-gated, audit-logged, 72h via queue) --------------

export async function requestLeadErasure(
  leadId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can erase a lead." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) return { ok: false, error: "Lead not found." };

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "lead.erasure.requested",
      entityType: "Lead",
      entityId: leadId,
      meta: { sla: "72h" },
    },
  });
  await enqueueLeadErasure({ workspaceId, leadId, requestedByUserId: userId });
  revalidatePath("/settings");
  return { ok: true };
}

// ---- retention policy (admin) ---------------------------------------------

export async function getRetention(): Promise<RetentionPolicy> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { retentionDays: true, featureFlags: true },
  });
  return parseRetention(ws ?? {});
}

const retentionSchema = z.object({
  anonymizeAfterDays: z.coerce.number().int().min(30).max(3650),
  eraseDocumentsOnErasure: z.boolean(),
  backupRotationDays: z.coerce.number().int().min(1).max(365),
});

export async function setRetention(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change retention settings." };
  }
  const parsed = retentionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid retention values." };
  const { workspaceId, userId } = await getActiveContext();

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags =
    ws?.featureFlags && typeof ws.featureFlags === "object" && !Array.isArray(ws.featureFlags)
      ? (ws.featureFlags as Record<string, unknown>)
      : {};
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: {
      retentionDays: parsed.data.anonymizeAfterDays,
      featureFlags: { ...flags, retention: parsed.data },
    },
  });
  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "retention.update", meta: parsed.data },
  });
  revalidatePath("/settings");
  return { ok: true };
}

// ---- full data export (CSV bundle, exports.run grant) ---------------------

export async function runExport(): Promise<
  { ok: true; path: string } | { ok: false; error: string }
> {
  try {
    await requireGrant("exports.run");
  } catch {
    return { ok: false, error: "You need the exports.run grant to export data." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const zip = await buildExportZip(db);
  const rel = `exports/${workspaceId}-${randomUUID()}.zip`;
  await mkdir(join(FILES_DIR, "exports"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), zip);

  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "export.run", meta: { path: rel, bytes: zip.length } },
  });
  revalidatePath("/settings");
  return { ok: true, path: rel };
}

export async function listErasableLeads(): Promise<Array<{ id: string; name: string }>> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const leads = await db.lead.findMany({
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { id: true, contactName: true, company: { select: { name: true } } },
  });
  return leads.map((l) => ({ id: l.id, name: l.contactName ?? l.company?.name ?? "Unnamed lead" }));
}
