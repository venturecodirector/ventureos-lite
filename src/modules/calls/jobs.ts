import { callbacksQueue } from "../../lib/queue";
import { getWorkspaceClient } from "../../lib/db";
import { notifyCallbackDue } from "../notifications/notify";

/**
 * Callback reminders (spec §4.17). A scheduled callback fires a delayed job at
 * the callback time that surfaces a Today Queue item (Activity). Background PWA
 * push (app closed) needs web-push/VAPID and is wired separately; when the app
 * is open, the Calls screen fires a client Notification for due callbacks.
 */
export interface CallbackJobData {
  callId: string;
  leadId: string;
  workspaceId: string;
}

export async function enqueueCallback(
  data: CallbackJobData,
  fireAt: Date,
): Promise<void> {
  const delay = Math.max(0, fireAt.getTime() - Date.now());
  await callbacksQueue().add("callback", data, {
    delay,
    jobId: `callback-${data.callId}`,
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

export async function cancelCallback(callId: string): Promise<void> {
  const job = await callbacksQueue().getJob(`callback:${callId}`);
  if (job) await job.remove();
}

export async function processCallbackDue(data: CallbackJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const call = await db.call.findUnique({
    where: { id: data.callId },
    select: { callbackDoneAt: true, byUserId: true },
  });
  if (!call || call.callbackDoneAt) return; // already handled

  await db.activity.create({
    data: {
      workspaceId: data.workspaceId,
      leadId: data.leadId,
      type: "callback_due",
      payload: { callId: data.callId },
    },
  });

  // P6/1 — the Today Queue item above is the passive half; this is the one that
  // reaches someone who is not looking at the app.
  await notifyCallbackDue({
    workspaceId: data.workspaceId,
    leadId: data.leadId,
    callId: data.callId,
    byUserId: call.byUserId,
  });
}
