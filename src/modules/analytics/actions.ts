"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { DealResult } from "@prisma/client";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { validateOutcome } from "./taxonomy";
import { buildWhatCloses, type WhatCloses } from "./aggregate";
import { getOutcomeFacts, type OutcomeTotals } from "./data";
import { getTopReferrers } from "@/modules/referrals/data";
import type { TopReferrer } from "@/modules/referrals/ledger";
import { enqueueAnalyticsPdf } from "@/modules/audit/enqueue";
import { collectReportInput } from "./report-data";
import { buildWeeklyReport, type WeeklyReport } from "./reports";
import { getLatestReport, type ReportView } from "./report-actions";
import { cached } from "@/lib/ttl-cache";

const closeSchema = z.object({
  leadId: z.string().min(1),
  result: z.string(),
  reason: z.string(),
  value: z.coerce.number(),
  competitor: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

/**
 * Close a Handed-off lead (spec §4.20). The outcome is REQUIRED and validated
 * against the taxonomy — this is the gate: no close without a valid outcome.
 */
export async function closeDeal(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = closeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid outcome submission." };
  const input = parsed.data;
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({ where: { id: input.leadId }, select: { stage: true } });
  if (!lead) return { ok: false, error: "Lead not found." };
  if (lead.stage !== "HANDED_OFF") {
    return { ok: false, error: "Only handed-off leads can be closed." };
  }

  const outcome = validateOutcome({
    result: input.result,
    reason: input.reason,
    value: input.value,
    competitor: input.competitor,
    note: input.note,
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const o = outcome.value;

  await db.dealOutcome.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      result: o.result.toUpperCase() as DealResult,
      reason: o.reason,
      value: o.value,
      competitor: o.competitor,
    },
  });
  await db.activity.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      type: "deal_closed",
      byUserId: userId,
      payload: {
        result: o.result,
        reason: o.reason,
        value: o.value,
        competitor: o.competitor,
        note: o.note,
      },
    },
  });
  await db.lead.update({ where: { id: input.leadId }, data: { lastActivityAt: new Date() } });

  revalidatePath("/pipeline");
  revalidatePath("/analytics");
  return { ok: true };
}

// ---- reads -----------------------------------------------------------------

export interface AnalyticsView {
  report: WeeklyReport; // live funnel/KPIs/sources/audit→meeting/doc-chain
  totals: OutcomeTotals;
  whatCloses: WhatCloses;
  topReferrers: TopReferrer[];
  latestReport: ReportView | null; // last stored Friday report (in-app view)
}

/**
 * The Performance tab's aggregates, cached for 60 seconds (P6/3).
 *
 * Four reads and a full pass over every outcome the workspace has ever
 * recorded, to produce numbers that change a few times a day. Keyed by
 * workspace — a cache shared across tenants would be a tenancy hole with a
 * performance justification.
 */
export async function getAnalytics(): Promise<AnalyticsView> {
  const { workspaceId } = await getActiveContext();
  return cached(`analytics:${workspaceId}`, () => computeAnalytics(workspaceId));
}

async function computeAnalytics(workspaceId: string): Promise<AnalyticsView> {
  const db = getWorkspaceClient(workspaceId);
  const now = Date.now();
  const [input, { facts, totals }, topReferrers, latestReport] = await Promise.all([
    collectReportInput(db, { weekLabel: "this week", sinceMs: now - 7 * 24 * 60 * 60_000, untilMs: now }),
    getOutcomeFacts(db),
    getTopReferrers(db, 5),
    getLatestReport(),
  ]);
  return {
    report: buildWeeklyReport(input),
    totals,
    whatCloses: buildWhatCloses(facts),
    topReferrers,
    latestReport,
  };
}

/** Handed-off leads that don't yet have a recorded outcome (need closing). */
export async function listOpenHandoffs(): Promise<
  Array<{ id: string; name: string; company: string }>
> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const leads = await db.lead.findMany({
    where: { stage: "HANDED_OFF" },
    include: { company: { select: { name: true } }, outcomes: { select: { id: true } } },
    orderBy: { stageEnteredAt: "desc" },
  });
  return leads
    .filter((l) => l.outcomes.length === 0)
    .map((l) => ({
      id: l.id,
      name: l.contactName ?? l.company?.name ?? "Unnamed lead",
      company: l.company?.name ?? "",
    }));
}

/**
 * Export the analytics currently on screen as a branded PDF.
 *
 * The rendering happens in the worker (Chromium lives only in that image), so
 * this enqueues and hands back the path to poll. The report snapshot travels
 * with the job so the document matches the figures the operator was looking
 * at, rather than a fresh aggregate taken moments later.
 */
export async function exportAnalyticsPdf(): Promise<{ path: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const now = Date.now();
  const input = await collectReportInput(db, {
    weekLabel: "this week",
    sinceMs: now - 7 * 24 * 60 * 60_000,
    untilMs: now,
  });
  const report = buildWeeklyReport(input);

  // exports/<workspaceId>-… is the shape resolveFileWorkspace already knows
  // how to attribute, so the authenticated file route stays tenant-scoped
  // without a schema change (hard rule #1).
  const rel = `exports/${workspaceId}-analytics-${now}.pdf`;
  await enqueueAnalyticsPdf({ workspaceId, rel, report, commentary: null });
  return { path: rel };
}
