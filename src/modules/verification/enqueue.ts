import { verifyQueue } from "@/lib/queue";

/** Hand the rest of a large audience to the worker. Never throws. */
export async function enqueueAudienceVerification(campaignId: string): Promise<void> {
  try {
    await verifyQueue().add(
      "verify-audience",
      { campaignId },
      // A hyphen, not a colon: BullMQ refuses a custom id containing ":".
      { jobId: `verify-${campaignId}`, removeOnComplete: true, attempts: 2 },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[verify] could not queue audience verification", e);
  }
}
