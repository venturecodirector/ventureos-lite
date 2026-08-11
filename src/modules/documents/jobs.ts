import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceClient, prismaUnsafe } from "../../lib/db";
import { renderHtmlToPdf } from "../../lib/pdf";
import { renderTemplate } from "../templates/render";
import { buildDocumentData } from "./data";
import { buildDocumentPdfHtml } from "./pdf-template";
import type { DocumentPdfJobData } from "./enqueue";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

/** Worker: render a document from its pinned template version to a PDF. */
export async function processDocumentPdf(data: DocumentPdfJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const doc = await db.document.findUnique({
    where: { id: data.documentId },
    include: {
      template: true,
      lead: { include: { company: true } },
    },
  });
  if (!doc || !doc.template) return;

  const workspace = await prismaUnsafe.workspace.findUnique({
    where: { id: data.workspaceId },
    select: { legalName: true, brand: true },
  });

  const templateData = buildDocumentData(doc, workspace);
  const { output } = renderTemplate(doc.template.body, templateData);
  const html = buildDocumentPdfHtml(output, doc.watermark);
  const pdf = await renderHtmlToPdf(html);

  const rel = `documents/${data.documentId}.pdf`;
  await mkdir(join(FILES_DIR, "documents"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), pdf);

  await db.document.update({ where: { id: data.documentId }, data: { pdfUrl: rel } });
}
