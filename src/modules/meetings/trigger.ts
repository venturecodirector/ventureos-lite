import { getWorkspaceClient } from "@/lib/db";
import { shouldGenerateBrief, type BriefStatus } from "./logic";
import { enqueueMeetingBrief } from "./enqueue";

/**
 * Entering the Meeting-booked stage triggers brief generation for the lead's
 * most recent meeting (spec §4.8). This is the ONE permitted non-manual Claude
 * trigger; it stays bounded to one call per booking because `shouldGenerateBrief`
 * gates on brief_status and the worker re-checks with an atomic claim.
 */
export async function enqueueBriefForLead(
  workspaceId: string,
  leadId: string,
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const meeting = await db.meeting.findFirst({
    where: { leadId },
    orderBy: { scheduledAt: "desc" },
    select: { id: true, briefStatus: true },
  });
  if (!meeting) return;
  if (!shouldGenerateBrief(meeting.briefStatus as BriefStatus)) return;
  await enqueueMeetingBrief({ meetingId: meeting.id, workspaceId });
}
