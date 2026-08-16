import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceClient, prismaUnsafe } from "../../lib/db";
import { renderHtmlToPdf } from "../../lib/pdf";
import { renderTemplate } from "../templates/render";
import { buildDocumentData } from "./data";
import { buildDocumentPdfHtml } from "./pdf-template";
import type { DocumentPdfJobData } from "./enqueue";
import type { Prisma } from "@prisma/client";
import { resolveDocumentBrand } from "./brand-snapshot";

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
  // A document that has already been rendered keeps the letterhead it was
  // issued under; the first render captures it (audit-v2 item 6).
  const pinned = resolveDocumentBrand(doc.brandSnapshot, workspace?.brand);
  const html = buildDocumentPdfHtml(output, doc.watermark, pinned.brand);
  const pdf = await renderHtmlToPdf(html);

  const rel = `documents/${data.documentId}.pdf`;
  await mkdir(join(FILES_DIR, "documents"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), pdf);

  await db.document.update({
    where: { id: data.documentId },
    data: {
      pdfUrl: rel,
      ...(pinned.shouldPersist
        ? {
            brandSnapshot: pinned.brand as unknown as Prisma.InputJsonValue,
            brandVersion: pinned.version,
          }
        : {}),
    },
  });
}
