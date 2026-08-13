import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderHtmlToPdf } from "@/lib/pdf";
import { buildReportPdfHtml } from "./report-pdf";
import type { WeeklyReport } from "./reports";

/**
 * Worker side of the on-demand analytics export.
 *
 * Runs here rather than in a server action because Chromium only exists in
 * the worker image — the app image is node:20-alpine with no browser.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export async function processAnalyticsPdf(data: {
  rel: string;
  report: WeeklyReport;
  commentary: string | null;
}): Promise<void> {
  const html = buildReportPdfHtml(data.report, data.commentary, null);
  const pdf = await renderHtmlToPdf(html);
  const abs = join(FILES_DIR, data.rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, pdf);
}
