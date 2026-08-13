import { pdfsQueue } from "@/lib/queue";
import type { Locale } from "@/lib/locale";

/**
 * Web-side enqueue only (no PDF or mail imports), so the public landing's
 * bundle stays small. The processor lives in ./report-job, in the worker.
 */
export interface ReportEmailJobData {
  consentId: string;
  workspaceId: string;
  auditId: string;
  locale: Locale;
}

export async function enqueueReportEmail(data: ReportEmailJobData): Promise<void> {
  await pdfsQueue().add("public-audit-report", data, {
    jobId: `public-report-${data.consentId}`,
    removeOnComplete: true,
    removeOnFail: 100,
    // A stranger is waiting on this email, and the two failure modes we can
    // actually recover from — a cold PDF pipeline, a Mailgun blip — both pass
    // within a minute.
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
  });
}
