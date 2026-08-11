"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import type { WeeklyReport } from "./reports";

export interface ReportView {
  id: string;
  weekLabel: string;
  data: WeeklyReport;
  commentary: string | null;
  comment: string | null;
  pdfPath: string | null;
  createdAt: string;
}

export async function getLatestReport(): Promise<ReportView | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const r = await db.report.findFirst({ orderBy: { createdAt: "desc" } });
  if (!r) return null;
  return {
    id: r.id,
    weekLabel: r.weekLabel,
    data: r.data as unknown as WeeklyReport,
    commentary: r.commentary,
    comment: r.comment,
    pdfPath: r.pdfPath,
    createdAt: r.createdAt.toISOString(),
  };
}

const commentSchema = z.object({ id: z.string().min(1), comment: z.string().max(2000) });

/** Fanni's comment field on the in-app report (spec §4.14). */
export async function setReportComment(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = commentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid comment." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.report.update({ where: { id: parsed.data.id }, data: { comment: parsed.data.comment } });
  revalidatePath("/analytics");
  return { ok: true };
}
