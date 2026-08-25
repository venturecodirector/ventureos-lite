"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import {
  WATCH_FREQUENCIES,
  maxWatchesFrom,
  projectedWeeklyLoad,
  nextRunFrom,
  shouldAutoWatch,
  WatchLimitReached,
} from "./watch";

/**
 * Turning audit watches on and off (P2/5).
 *
 * The cap is enforced HERE rather than in the UI, because the cost of an
 * over-subscribed watch list is paid by the worker at four in the morning,
 * where nobody is watching a button state.
 */
const setSchema = z.object({
  companyId: z.string().min(1),
  frequencyDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
});

export interface WatchView {
  companyId: string;
  companyName: string;
  url: string;
  frequencyDays: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
}

export interface WatchListView {
  watches: WatchView[];
  /** Audits per week the current list implies, rounded up. */
  weeklyLoad: number;
  max: number;
}

export async function listAuditWatches(): Promise<WatchListView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  const rows = await db.auditWatch.findMany({
    include: { company: { select: { name: true } } },
    orderBy: { nextRunAt: "asc" },
  });

  return {
    watches: rows.map((w) => ({
      companyId: w.companyId,
      companyName: w.company.name,
      url: w.url,
      frequencyDays: w.frequencyDays,
      enabled: w.enabled,
      nextRunAt: w.nextRunAt.toISOString(),
      lastRunAt: w.lastRunAt?.toISOString() ?? null,
    })),
    weeklyLoad: projectedWeeklyLoad(rows),
    max: maxWatchesFrom(ws?.auditConfig),
  };
}

export async function setAuditWatch(raw: unknown): Promise<{ nextRunAt: string }> {
  const input = setSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const company = await db.company.findUnique({
    where: { id: input.companyId },
    select: { website: true, domain: true },
  });
  if (!company) throw new Error("Company not found");
  const raw_url = company.website ?? company.domain;
  if (!raw_url) throw new Error("This company has no website to watch.");
  const url = /^https?:\/\//i.test(raw_url) ? raw_url : `https://${raw_url}`;

  const existing = await db.auditWatch.findUnique({ where: { companyId: input.companyId } });
  if (!existing) {
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { auditConfig: true },
    });
    const max = maxWatchesFrom(ws?.auditConfig);
    const live = await db.auditWatch.count({ where: { enabled: true } });
    if (live >= max) throw new WatchLimitReached(max);
  }

  // The first run is one interval out, not immediately: we have just audited
  // this site or we would not be looking at it.
  const nextRunAt = existing?.nextRunAt ?? nextRunFrom(new Date(), input.frequencyDays);
  const row = await db.auditWatch.upsert({
    where: { companyId: input.companyId },
    create: {
      workspaceId,
      companyId: input.companyId,
      url,
      frequencyDays: input.frequencyDays,
      enabled: true,
      nextRunAt,
      createdBy: userId,
    },
    update: { frequencyDays: input.frequencyDays, enabled: true, url },
  });
  revalidatePath("/audit");
  return { nextRunAt: row.nextRunAt.toISOString() };
}

export async function clearAuditWatch(companyId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.auditWatch.deleteMany({ where: { companyId } });
  revalidatePath("/audit");
  return { ok: true };
}


/**
 * Turn a watch on for a lead that has just reached a stage worth watching.
 *
 * Called from the stage-change path. Silent by design: it must never be the
 * reason a stage change fails, and an over-cap workspace simply does not get
 * the automatic watch (an explicit one still reports the limit).
 */
export async function autoWatchForStage(
  companyId: string | null,
  stage: string,
): Promise<void> {
  if (!companyId || !shouldAutoWatch(stage)) return;
  try {
    await setAuditWatch({ companyId, frequencyDays: WATCH_FREQUENCIES[1] });
  } catch {
    /* cap reached, no website, or a race — none of which is the caller's problem */
  }
}
