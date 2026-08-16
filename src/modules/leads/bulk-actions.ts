"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Stage } from "@prisma/client";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant, requireOwner } from "@/lib/authz";
import { autoWatchForStage } from "../audit/watch-actions";
import { cancelFollowups, scheduleFollowups } from "../pipeline/jobs";
import { cancelsFollowups, schedulesFollowups } from "../pipeline/transitions";
import { gateThresholdFromConfig } from "./scoring";
import { filterSetSchema } from "./view-params";
import type { BulkResult } from "./bulk";
import {
  applyOwner,
  applySignals,
  applyStageChange,
  deleteLeadsBulk,
  exportLeadsCsv,
  resolveSelection,
  type StageChangeResult,
} from "./bulk-store";
import type { FilterSet } from "./filters";

/**
 * Bulk-action server actions (playbook-v2 P3/2).
 *
 * The browser sends a list of ids and the server does the rest. Passing ids is
 * safe because every mutation runs through the guarded client, so an id from
 * another workspace simply matches nothing — and because the gates (score,
 * qualification, grants) are re-checked here per lead rather than trusted from
 * whatever the table happened to render.
 *
 * Work arrives in batches from the client (BULK_BATCH_SIZE) so that moving 500
 * leads shows a progress bar instead of one long unexplained wait.
 */

const idsSchema = z.array(z.string().min(1)).max(500);

/**
 * "Select all matching" resolves HERE, from the filter, not from a list the
 * browser assembled. What the filter means is a server-side question.
 */
export async function resolveBulkSelection(rawFilters: unknown): Promise<string[]> {
  const parsed = filterSetSchema.safeParse(rawFilters);
  if (!parsed.success) return [];
  const { workspaceId } = await getActiveContext();
  return resolveSelection(workspaceId, parsed.data as FilterSet);
}

async function threshold(workspaceId: string): Promise<number> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { icpConfig: true },
  });
  return gateThresholdFromConfig(ws?.icpConfig);
}

const stageSchema = z.object({
  ids: idsSchema,
  toStage: z.enum([
    "RESEARCHED",
    "CONTACTED",
    "ACCEPTED",
    "REPLIED",
    "QUALIFIED",
    "MEETING_BOOKED",
    "HANDED_OFF",
    "NOT_NOW",
    "DISQUALIFIED",
  ]),
  reason: z.string().optional(),
  wakeUpAt: z.string().optional(),
});

export async function bulkChangeStage(raw: unknown): Promise<BulkResult> {
  const parsed = stageSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId, userId } = await getActiveContext();

  const result: StageChangeResult = await applyStageChange(
    workspaceId,
    userId,
    parsed.data.ids,
    parsed.data.toStage,
    await threshold(workspaceId),
    {
      reason: parsed.data.reason,
      wakeUpAt: parsed.data.wakeUpAt ? new Date(parsed.data.wakeUpAt) : undefined,
    },
  );

  // Task-level automations only, never messaging (CLAUDE.md hard rule #2).
  // Best-effort, exactly as the single-lead path: an automation failing must
  // not undo a move that has already happened.
  const toStage = parsed.data.toStage as Stage;
  for (const lead of result.moved) {
    try {
      await autoWatchForStage(lead.companyId, toStage);
      if (schedulesFollowups(toStage)) await scheduleFollowups(lead.id, workspaceId);
      if (cancelsFollowups(toStage)) await cancelFollowups(lead.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[bulk] stage automation failed", lead.id, e);
    }
  }

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return { applied: result.applied, skipped: result.skipped };
}

const signalsSchema = z.object({
  ids: idsSchema,
  add: z.array(z.string()).max(20).optional(),
  remove: z.array(z.string()).max(20).optional(),
});

export async function bulkEditSignals(raw: unknown): Promise<BulkResult> {
  const parsed = signalsSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const result = await applySignals(workspaceId, parsed.data.ids, {
    add: parsed.data.add,
    remove: parsed.data.remove,
  });
  revalidatePath("/leads");
  return result;
}

const ownerSchema = z.object({
  ids: idsSchema,
  ownerId: z.string().nullable(),
});

export async function bulkAssignOwner(raw: unknown): Promise<BulkResult> {
  const parsed = ownerSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  const { workspaceId } = await getActiveContext();
  const result = await applyOwner(workspaceId, parsed.data.ids, parsed.data.ownerId);
  revalidatePath("/leads");
  return result;
}

/**
 * Deleting is erasure and Owner-only, matching the single-lead path — a bulk
 * delete must not be a weaker second door to the same thing. Audit-logged per
 * lead in the store (CLAUDE.md hard rule #8).
 */
export async function bulkDeleteLeads(
  raw: unknown,
): Promise<BulkResult & { error?: string }> {
  const parsed = idsSchema.safeParse(raw);
  if (!parsed.success) return { applied: 0, skipped: [] };
  try {
    await requireOwner();
  } catch {
    return { applied: 0, skipped: [], error: "Only an Owner can delete leads." };
  }
  const { workspaceId, userId } = await getActiveContext();
  const result = await deleteLeadsBulk(workspaceId, userId, parsed.data);
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return result;
}

const exportSchema = z.object({
  ids: idsSchema,
  columns: z.array(z.string()).max(30),
});

/**
 * Exporting is grant-gated (`exports.run`, spec §3) and audit-logged, like
 * every other route data leaves by.
 */
export async function bulkExportCsv(
  raw: unknown,
): Promise<{ ok: true; csv: string; rows: number } | { ok: false; error: string }> {
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Nothing to export." };
  try {
    await requireGrant("exports.run");
  } catch {
    return { ok: false, error: "You need the exports.run grant to export leads." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const csv = await exportLeadsCsv(workspaceId, parsed.data.ids, parsed.data.columns);

  await prismaUnsafe.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "export.run",
      meta: { kind: "leads.csv", rows: parsed.data.ids.length, columns: parsed.data.columns },
    },
  });

  return { ok: true, csv, rows: parsed.data.ids.length };
}
