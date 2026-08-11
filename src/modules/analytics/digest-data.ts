import type { WorkspaceClient } from "../../lib/db";
import { getTopReferrers } from "../referrals/data";
import type { DigestInput } from "./reports";

/**
 * Collect the Monday digest inputs for one workspace (spec §4.22). ALL reads go
 * through the guarded workspace client, so a digest only ever reflects its own
 * workspace's data — that is the scoping guarantee the tests pin.
 */
export async function collectDigestData(
  db: WorkspaceClient,
  opts: { isOwner: boolean; nowMs: number },
): Promise<DigestInput> {
  const now = new Date(opts.nowMs);
  const weekAgo = new Date(opts.nowMs - 7 * 24 * 60 * 60_000);

  const [dueCallbacks, researchedLeads, overdueFollowups, pipelineAdvances, pendingApprovals, top] =
    await Promise.all([
      db.call.count({ where: { callbackAt: { lte: now }, callbackDoneAt: null } }),
      db.lead.count({ where: { stage: "RESEARCHED" } }),
      db.lead.count({ where: { stage: { in: ["CONTACTED", "ACCEPTED"] }, stageEnteredAt: { lt: weekAgo } } }),
      db.activity.count({ where: { type: "stage_change", at: { gte: weekAgo } } }),
      opts.isOwner ? db.proposal.count({ where: { status: "PENDING" } }) : Promise.resolve(0),
      getTopReferrers(db, 1),
    ]);

  return {
    todayQueueCount: dueCallbacks + overdueFollowups + researchedLeads,
    dueCallbacks,
    overdueFollowups,
    pipelineAdvances,
    pendingApprovals,
    topReferrer: top[0] ? { name: top[0].name, revenue: top[0].attributedRevenue } : null,
    isOwner: opts.isOwner,
  };
}
