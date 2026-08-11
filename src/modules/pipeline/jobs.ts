import { followupsQueue } from "../../lib/queue";
import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import {
  followupPlan,
  wakeUpDate,
  shouldAutoNotNow,
  type FollowupType,
} from "./schedule";

/**
 * Follow-up automations (spec §4.5–4.6): task-level only, never messaging. Jobs
 * are keyed by lead+type so they can be cancelled/deduped when the lead advances.
 */

interface FollowupData {
  leadId: string;
  workspaceId: string;
  type: FollowupType;
}

const FOLLOWUP_TYPES: FollowupType[] = ["fu1", "fu2", "auto_notnow"];

function jobId(leadId: string, type: FollowupType): string {
  return `lead:${leadId}:${type}`;
}

/** Enqueue FU1/FU2/auto-Not-now when a lead is Accepted. Best-effort. */
export async function scheduleFollowups(
  leadId: string,
  workspaceId: string,
): Promise<void> {
  const q = followupsQueue();
  await Promise.all(
    followupPlan().map((spec) =>
      q.add(
        spec.type,
        { leadId, workspaceId, type: spec.type } satisfies FollowupData,
        {
          delay: spec.delayMs,
          jobId: jobId(leadId, spec.type),
          removeOnComplete: true,
          removeOnFail: 100,
        },
      ),
    ),
  );
}

/** Cancel any pending follow-ups (lead replied / left the cadence). */
export async function cancelFollowups(leadId: string): Promise<void> {
  const q = followupsQueue();
  await Promise.all(
    FOLLOWUP_TYPES.map(async (t) => {
      const job = await q.getJob(jobId(leadId, t));
      if (job) await job.remove();
    }),
  );
}

/** Worker processor for a single follow-up job. */
export async function processFollowup(data: FollowupData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: data.leadId },
    select: { stage: true },
  });
  if (!lead) return;

  if (data.type === "auto_notnow") {
    // Max 2 follow-ups then auto Not-now — only if still no reply.
    if (shouldAutoNotNow(lead.stage)) {
      const now = new Date();
      await db.lead.update({
        where: { id: data.leadId },
        data: {
          stage: "NOT_NOW",
          stageEnteredAt: now,
          wakeUpAt: wakeUpDate(now),
          stageReason: "Auto — no reply after FU2",
        },
      });
      await db.activity.create({
        data: {
          workspaceId: data.workspaceId,
          leadId: data.leadId,
          type: "auto_not_now",
          payload: { reason: "no reply after FU2" },
        },
      });
    }
    return;
  }

  // fu1 / fu2: surface a due follow-up task only while still awaiting a reply.
  if (shouldAutoNotNow(lead.stage)) {
    await db.activity.create({
      data: {
        workspaceId: data.workspaceId,
        leadId: data.leadId,
        type: "followup_due",
        payload: { step: data.type },
      },
    });
  }
}

/**
 * Daily wake-up sweep (spec §4.5): surface Not-now leads whose wake-up date has
 * arrived. This is a cross-workspace SYSTEM job (like anonymization), so it uses
 * the unguarded client deliberately and scopes each write by the row's own
 * workspace_id.
 */
export async function processWakeupSweep(now = new Date()): Promise<number> {
  const due = await prismaUnsafe.lead.findMany({
    where: { stage: "NOT_NOW", wakeUpAt: { lte: now } },
    select: { id: true, workspaceId: true },
  });
  for (const l of due) {
    await prismaUnsafe.activity.create({
      data: { workspaceId: l.workspaceId, leadId: l.id, type: "wake_up", payload: {} },
    });
    await prismaUnsafe.lead.update({ where: { id: l.id }, data: { wakeUpAt: null } });
  }
  return due.length;
}
