/**
 * The two notification sweeps (playbook-v2 P6/1).
 *
 * Everything else is raised at the moment its event happens. These two exist
 * because their "event" is time passing, which nothing else in the system is
 * watching for.
 */

import { prismaUnsafe } from "@/lib/db";
import { notifyTaskDue } from "./notify";
import { purgeExpiredNotifications, type NotificationView } from "./store";
import { retentionCutoff } from "./types";

/** UTC day stamp — the dedupe discriminator that makes an overdue task nag daily. */
export function dayStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Notify about tasks that have come due.
 *
 * Runs hourly. A task due at 14:00 is picked up by the 14:00 pass; one that
 * stays undone keeps being picked up, but the day stamp in the dedupe key means
 * it produces ONE notification per day rather than one per hour — nagging is
 * useful, hourly nagging is how a bell gets muted.
 *
 * Cross-workspace, like the other sweeps, so it reads through the unguarded
 * client deliberately and hands each row's own workspace to the emitter.
 */
export async function processTaskDueSweep(now: Date = new Date()): Promise<number> {
  const due = await prismaUnsafe.task.findMany({
    where: { doneAt: null, dueAt: { not: null, lte: now } },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      assigneeId: true,
      dueAt: true,
    },
    // A bound, so a workspace that has let a thousand tasks rot cannot make one
    // sweep run for ever. The rest are caught on the next pass.
    take: 500,
    orderBy: { dueAt: "asc" },
  });

  const day = dayStamp(now);
  let notified = 0;
  for (const task of due) {
    // "Overdue" means it was due before today, not merely before this minute:
    // a task due at 09:00 is not yet late at 09:05 in the way a person means it.
    const overdue = !!task.dueAt && task.dueAt.toISOString().slice(0, 10) < day;
    await notifyTaskDue({
      workspaceId: task.workspaceId,
      taskId: task.id,
      title: task.title,
      assigneeId: task.assigneeId,
      overdue,
      day,
    });
    notified += 1;
  }
  return notified;
}

/** 90-day retention (playbook P6/1). Runs nightly. */
export async function processNotificationRetention(now: Date = new Date()): Promise<number> {
  return purgeExpiredNotifications(retentionCutoff(now));
}

export type { NotificationView };
