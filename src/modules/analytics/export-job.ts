import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderHtmlToPdf } from "@/lib/pdf";
import { buildReportPdfHtml } from "./report-pdf";
import type { WeeklyReport } from "./reports";
import { prismaUnsafe } from "@/lib/db";
import { brandFrom } from "@/modules/workspaces/brand";

/**
 * Worker side of the on-demand analytics export.
 *
 * Runs here rather than in a server action because Chromium only exists in
 * the worker image — the app image is node:20-alpine with no browser.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export async function processAnalyticsPdf(data: {
  workspaceId?: string;
  rel: string;
  report: WeeklyReport;
  commentary: string | null;
}): Promise<void> {
  // Branded per workspace (audit-v2 item 6). `rel` already carries the
  // workspace id, but the brand comes from the row rather than the path.
  const ws = data.workspaceId
    ? await prismaUnsafe.workspace.findUnique({
        where: { id: data.workspaceId },
        select: { brand: true },
      })
    : null;
  const html = buildReportPdfHtml(data.report, data.commentary, null, brandFrom(ws?.brand));
  const pdf = await renderHtmlToPdf(html);
  const abs = join(FILES_DIR, data.rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, pdf);
}
