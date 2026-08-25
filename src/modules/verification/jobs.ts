import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { verifyAudience } from "./store";

/**
 * Finish verifying a large audience in the worker (playbook-v3 P9/2).
 *
 * The action verifies the first hundred so the operator sees an answer
 * immediately; anything beyond that lands here, where there is no request
 * timeout to run into and the provider rate limit can take as long as it needs.
 *
 * Idempotent: `verifyAudience` reuses a fresh verdict, so re-running this costs
 * nothing and cannot double-charge a paid verifier.
 */
export async function processAudienceVerification(campaignId: string): Promise<number> {
  const campaign = await prismaUnsafe.campaign.findUnique({
    where: { id: campaignId },
    select: { workspaceId: true },
  });
  if (!campaign) return 0;

  const db = getWorkspaceClient(campaign.workspaceId);
  let guard = 0;
  let verified = 0;
  // Walk the audience in passes rather than in one unbounded loop: a segment
  // can be thousands and a single transaction-free sweep is easier to reason
  // about than a cursor. The guard is a runaway stop, not a cap on coverage.
  for (;;) {
    const breakdown = await verifyAudience(db, campaign.workspaceId, campaignId, { max: 200 });
    verified += breakdown.total - breakdown.pending;
    if (breakdown.pending === 0) break;
    if (++guard > 50) {
      // eslint-disable-next-line no-console
      console.error(`[verify] gave up on ${campaignId} with ${breakdown.pending} left`);
      break;
    }
  }
  return verified;
}
