import { pdfsQueue } from "@/lib/queue";

/**
 * Queue the commission PDF (playbook-v3 P11/1d).
 *
 * Rendered in the WORKER, like every other PDF here: Chromium exists only in
 * the worker image — the app image is node:20-alpine with no browser.
 */
export interface CommissionPdfJobData {
  workspaceId: string;
  /** Relative path under FILES_DIR. */
  rel: string;
  kind: "monthly" | "settlement";
  report: unknown;
}

export async function enqueueCommissionPdf(data: CommissionPdfJobData): Promise<void> {
  await pdfsQueue().add("commission-pdf", data, {
    jobId: `commission-${data.rel}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}
