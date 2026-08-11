import { auditsQueue, pdfsQueue } from "../../lib/queue";

/**
 * Web-side enqueue only (no Playwright import), so the Next bundle stays light.
 * The heavy processor lives in ./jobs (worker service).
 */
export interface AuditJobData {
  auditId: string;
  workspaceId: string;
  url: string;
  leadId?: string;
  withPitch: boolean;
}

export async function enqueueAudit(data: AuditJobData): Promise<void> {
  await auditsQueue().add("audit", data, {
    jobId: `audit-${data.auditId}`,
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export interface PdfJobData {
  auditId: string;
  workspaceId: string;
}

export async function enqueuePdfRender(data: PdfJobData): Promise<void> {
  await pdfsQueue().add("audit-pdf", data, {
    jobId: `pdf-${data.auditId}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}
