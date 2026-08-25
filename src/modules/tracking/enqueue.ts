import { visitsQueue } from "@/lib/queue";

/**
 * Identify the visitor, a minute from now.
 *
 * The delay is the point. Enriching the instant a session opens would name the
 * company correctly and then report "0 mp" for how long they read — the signal
 * a salesperson acts on is "Danubia megnézte az ajánlatot, 2 perc 40 mp", and
 * that number only exists after the heartbeats have had time to arrive.
 */
const ENRICH_DELAY_MS = 60_000;

export async function enqueueVisitEnrichment(
  visitId: string,
  workspaceId: string,
): Promise<void> {
  try {
    await visitsQueue().add(
      "enrich-visit",
      { visitId, workspaceId },
      {
        // One job per visit, however many times this is called.
        jobId: `visit:${visitId}`,
        delay: ENRICH_DELAY_MS,
        removeOnComplete: true,
        attempts: 2,
        backoff: { type: "fixed", delay: 30_000 },
      },
    );
  } catch (e) {
    // A dead Redis must not turn a prospect's page view into an error.
    // eslint-disable-next-line no-console
    console.error("[tracking] could not queue enrichment", e);
  }
}
