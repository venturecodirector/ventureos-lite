import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderHtmlToPdf } from "@/lib/pdf";
import { prismaUnsafe } from "@/lib/db";
import { brandFrom } from "@/modules/workspaces/brand";
import { buildCommissionPdfHtml, buildSettlementPdfHtml } from "./commission-pdf";
import type { CommissionReport, SettlementReport } from "./commission-data";
import type { CommissionPdfJobData } from "./enqueue";

/**
 * Worker side of the commission export (playbook-v3 P11/1d). Data in, PDF out —
 * no AI in the path of a document that decides what somebody is paid, for the
 * same reason CLAUDE.md keeps it out of legal documents.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export async function processCommissionPdf(data: CommissionPdfJobData): Promise<void> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: data.workspaceId },
    select: { brand: true },
  });
  const brand = brandFrom(ws?.brand);

  const html =
    data.kind === "settlement"
      ? buildSettlementPdfHtml(data.report as SettlementReport, brand)
      : buildCommissionPdfHtml(data.report as CommissionReport, brand);

  const pdf = await renderHtmlToPdf(html);
  const abs = join(FILES_DIR, data.rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, pdf);
}
