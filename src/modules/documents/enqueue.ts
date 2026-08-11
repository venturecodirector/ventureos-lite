import { pdfsQueue } from "../../lib/queue";

/** Web-side enqueue for the document PDF render (headless-Chrome pipeline). */
export interface DocumentPdfJobData {
  documentId: string;
  workspaceId: string;
}

export async function enqueueDocumentPdf(data: DocumentPdfJobData): Promise<void> {
  await pdfsQueue().add("document-pdf", data, {
    jobId: `docpdf-${data.documentId}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}
