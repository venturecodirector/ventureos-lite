/**
 * Meeting brief lifecycle (spec §4.8). Brief generation is bounded to ONE Sonnet
 * call per booking: only a 'none' → 'generating' claim proceeds, so entering the
 * Meeting-booked stage a second time cannot re-trigger it.
 */
export type BriefStatus = "none" | "generating" | "done" | "error";

export function shouldGenerateBrief(status: BriefStatus): boolean {
  return status === "none";
}

export function claimBriefTransition(current: BriefStatus): {
  claim: boolean;
  next: BriefStatus;
} {
  if (current === "none") return { claim: true, next: "generating" };
  return { claim: false, next: current };
}

/** Calendar failures surface in the Today Queue as an Activity (spec §4.8). */
export interface CalendarFailure {
  meetingId: string;
  leadId: string | null;
  error: string;
}

export function calendarFailureActivity(f: CalendarFailure): {
  type: "calendar_failed";
  leadId: string | null;
  payload: Record<string, unknown>;
} {
  return {
    type: "calendar_failed",
    leadId: f.leadId,
    payload: { meetingId: f.meetingId, error: f.error },
  };
}
