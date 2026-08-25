"use server";

import { z } from "zod";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { enqueueCommissionPdf } from "./enqueue";
import {
  buildCommissionReport,
  buildSettlementReport,
  type CommissionReport,
  type SettlementReport,
} from "./commission-data";

/**
 * The commission report (playbook-v3 P11/1d).
 *
 * OWNER-ONLY throughout. This is everyone's pay: a BDR must not be able to read
 * a colleague's figures, and the report is the whole workspace at once, so
 * there is no version of it that is safe to show anyone else.
 *
 * The system computes and never moves money. Nothing here writes a payment,
 * queues a transfer, or marks anything as paid.
 */

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM");


export async function getCommissionReport(
  raw: unknown,
): Promise<{ ok: true; report: CommissionReport } | { ok: false; error: string }> {
  const parsed = monthSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a month." };
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Commission reports are Owner-only." };
  }
  const { workspaceId } = await getActiveContext();
  return { ok: true, report: await buildCommissionReport(workspaceId, parsed.data) };
}

export async function getSettlementReport(
  raw: unknown,
): Promise<{ ok: true; report: SettlementReport } | { ok: false; error: string }> {
  const parsed = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick an end date." };
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Commission reports are Owner-only." };
  }
  const { workspaceId } = await getActiveContext();
  return {
    ok: true,
    report: await buildSettlementReport(workspaceId, new Date(`${parsed.data}T00:00:00Z`)),
  };
}

/**
 * Queue the branded PDF for payroll, and AUDIT-LOG it.
 *
 * Generating this report is an audited action (CLAUDE.md hard rule #8 lists
 * exports): it puts every person's earnings into a file that leaves the system,
 * and who asked for it and when is part of the record.
 */
export async function exportCommissionPdf(
  raw: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const parsed = monthSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a month." };
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Commission reports are Owner-only." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const report = await buildCommissionReport(workspaceId, parsed.data);

  // exports/<workspaceId>-… is the shape the authenticated file route already
  // knows how to attribute, so the PDF stays tenant-scoped without a schema
  // change (hard rule #1).
  const rel = `exports/${workspaceId}-commission-${parsed.data}-${Date.now()}.pdf`;
  await enqueueCommissionPdf({ workspaceId, rel, kind: "monthly", report });

  await prismaUnsafe.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "export.run",
      meta: {
        kind: "commission.pdf",
        month: parsed.data,
        path: rel,
        totalPayable: report.totalPayable,
        users: report.users.length,
      },
    },
  });

  return { ok: true, path: rel };
}

export async function exportSettlementPdf(
  raw: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const parsed = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick an end date." };
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Commission reports are Owner-only." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const report = await buildSettlementReport(workspaceId, new Date(`${parsed.data}T00:00:00Z`));
  const rel = `exports/${workspaceId}-settlement-${parsed.data}-${Date.now()}.pdf`;
  await enqueueCommissionPdf({ workspaceId, rel, kind: "settlement", report });

  await prismaUnsafe.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "export.run",
      meta: {
        kind: "commission.settlement.pdf",
        endDate: parsed.data,
        path: rel,
        totalCommission: report.totalCommission,
        totalRemainingNet: report.totalRemainingNet,
      },
    },
  });

  return { ok: true, path: rel };
}
