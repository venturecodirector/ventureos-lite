import { briefsQueue } from "../../lib/queue";

/**
 * Web-side enqueue for meeting-brief generation (no Anthropic/Playwright import,
 * so the Next bundle stays light). The processor lives in ./jobs (worker).
 *
 * jobId is keyed to the meeting so BullMQ dedupes concurrent enqueues — a belt
 * to the DB-level atomic claim that guarantees ONE Sonnet call per booking.
 */
export interface BriefJobData {
  meetingId: string;
  workspaceId: string;
}

export async function enqueueMeetingBrief(data: BriefJobData): Promise<void> {
  await briefsQueue().add("meeting-brief", data, {
    jobId: `brief-${data.meetingId}`,
    removeOnComplete: true,
    removeOnFail: 50,
  });
}
