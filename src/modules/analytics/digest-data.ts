import type { WorkspaceClient } from "../../lib/db";
import { getTopReferrers } from "../referrals/data";
import { countDigestableUnread } from "../notifications/digest";
import { loadClientHealth } from "../revenue/health-data";
import type { DigestInput } from "./reports";

/**
 * Collect the Monday digest inputs for one workspace (spec §4.22). ALL reads go
 * through the guarded workspace client, so a digest only ever reflects its own
 * workspace's data — that is the scoping guarantee the tests pin.
 */
export async function collectDigestData(
  db: WorkspaceClient,
  opts: {
    isOwner: boolean;
    nowMs: number;
    userId?: string;
    role?: string;
    /** Needed for the client-health section, which reads outside `db`. */
    workspaceId?: string;
  },
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

  // P6/1 email fallback: unread notifications of the types this user left on
  // for the digest. Counted here rather than mailed per event.
  const unreadNotifications = opts.userId
    ? await countDigestableUnread(db, opts.userId, opts.role ?? "BDR")
    : 0;

  /**
   * P11/2c — milestones past their date on projects still running.
   *
   * Counted through the TASKS, because a milestone is a task: one source of
   * truth for "done", so this figure cannot disagree with the checklist.
   */
  const openProjects = await db.project.findMany({
    where: { closedAt: null },
    select: { id: true },
  });
  const overdueMilestones = openProjects.length
    ? await db.task.count({
        where: {
          source: "project_milestone",
          doneAt: null,
          dueAt: { not: null, lt: now },
          entityType: "project",
          entityId: { in: openProjects.map((p) => p.id) },
        },
      })
    : 0;

  // P11/1c — how many clients the health rules put in the red this week.
  const redClients = opts.workspaceId
    ? (await loadClientHealth(opts.workspaceId, now)).filter((c) => c.level === "red").length
    : 0;

  return {
    overdueMilestones,
    redClients,
    unreadNotifications,
    todayQueueCount: dueCallbacks + overdueFollowups + researchedLeads,
    dueCallbacks,
    overdueFollowups,
    pipelineAdvances,
    pendingApprovals,
    topReferrer: top[0] ? { name: top[0].name, revenue: top[0].attributedRevenue } : null,
    isOwner: opts.isOwner,
  };
}
