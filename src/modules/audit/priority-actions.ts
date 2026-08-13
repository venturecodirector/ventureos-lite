"use server";

import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { buildPriorityMatrix, priorityMapFrom, type PriorityMatrix } from "./priority";
import { buildQuoteSkeleton, serviceMapFrom, isSeededMap, type QuoteSkeletonLine } from "./service-map";
import { CHECK_META } from "./categories";
import type { AuditCheck } from "./types";

/**
 * The prioritised view of an audit, and the quote skeleton it can produce
 * (P2/4). Nothing here calls Claude: both are lookups over declared metadata.
 */
export interface PriorityView {
  matrix: PriorityMatrix;
  /** True while the workspace is still on the seeded price bands. */
  pricesAreSeeded: boolean;
}

async function checksFor(auditId: string, workspaceId: string): Promise<AuditCheck[]> {
  const db = getWorkspaceClient(workspaceId);
  const a = await db.auditResult.findUnique({
    where: { id: auditId },
    select: { checks: true },
  });
  if (!a) throw new Error("Audit not found");
  return Array.isArray(a.checks) ? (a.checks as unknown as AuditCheck[]) : [];
}

export async function getPriorityView(auditId: string): Promise<PriorityView> {
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  const checks = await checksFor(auditId, workspaceId);
  return {
    matrix: buildPriorityMatrix(checks, priorityMapFrom(ws?.auditConfig)),
    pricesAreSeeded: isSeededMap(ws?.auditConfig),
  };
}

const skeletonSchema = z.object({
  auditId: z.string().min(1),
  /** Which findings the operator picked; empty means every failing check. */
  checkKeys: z.array(z.string()).optional(),
});

/**
 * Preview the quote lines selected findings would produce.
 *
 * Deliberately a separate step from creating the quote: the operator sees the
 * lines and the price bands BEFORE a draft document exists, because a quote is
 * a legal document in this system and should not appear by accident.
 */
export async function previewQuoteSkeleton(raw: unknown): Promise<{
  lines: QuoteSkeletonLine[];
  pricesAreSeeded: boolean;
}> {
  const input = skeletonSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });

  const checks = await checksFor(input.auditId, workspaceId);
  const selected = checks.filter(
    (c) => !c.pass && (!input.checkKeys?.length || input.checkKeys.includes(c.key)),
  );

  return {
    lines: buildQuoteSkeleton(
      selected.map((c) => ({
        key: c.key,
        label: c.label,
        category: CHECK_META[c.key]?.category ?? null,
      })),
      serviceMapFrom(ws?.auditConfig),
    ),
    pricesAreSeeded: isSeededMap(ws?.auditConfig),
  };
}

/**
 * The lead this audit belongs to, so the quote builder can be opened prefilled.
 *
 * A quote hangs off a lead in this system (deals do not exist yet — when they
 * do, this is the one place that changes).
 */
export async function leadForAudit(auditId: string): Promise<string | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const a = await db.auditResult.findUnique({
    where: { id: auditId },
    select: { companyId: true },
  });
  if (!a?.companyId) return null;
  const lead = await db.lead.findFirst({
    where: { companyId: a.companyId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return lead?.id ?? null;
}
