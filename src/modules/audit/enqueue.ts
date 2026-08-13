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

/**
 * Ad-hoc analytics export. The report snapshot rides in the payload rather
 * than being recomputed worker-side, so the PDF is exactly the figures the
 * operator was looking at when they pressed the button — not a fresh
 * aggregate that may have moved.
 */
export interface AnalyticsPdfJobData {
  workspaceId: string;
  /** Relative path under FILES_DIR, e.g. exports/<workspaceId>-analytics-<ts>.pdf */
  rel: string;
  report: unknown;
  commentary: string | null;
}

export async function enqueueAnalyticsPdf(data: AnalyticsPdfJobData): Promise<void> {
  await pdfsQueue().add("analytics-pdf", data, {
    jobId: `analytics-${data.rel}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}
