import { auditsQueue } from "@/lib/queue";

/** Kick off a sector batch. Never throws — the report stays in `running`. */
export async function enqueueSectorBatch(reportId: string): Promise<void> {
  try {
    await auditsQueue().add(
      "sector-batch",
      { reportId },
      { jobId: `sector-${reportId}`, removeOnComplete: true, attempts: 2 },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[sector] could not queue batch", e);
  }
}
