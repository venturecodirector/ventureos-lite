import type { Stage } from "@prisma/client";

/**
 * Pipeline stage model (spec §4.5). The main lane is a linear flow; Not now and
 * Disqualified are side lanes with their own rules.
 */
export const PIPELINE_STAGES: Stage[] = [
  "RESEARCHED",
  "CONTACTED",
  "ACCEPTED",
  "REPLIED",
  "QUALIFIED",
  "MEETING_BOOKED",
  "HANDED_OFF",
];

export const SIDE_STAGES: Stage[] = ["NOT_NOW", "DISQUALIFIED"];

export const STAGE_LABELS: Record<Stage, string> = {
  RESEARCHED: "Researched",
  CONTACTED: "Contacted",
  ACCEPTED: "Accepted",
  REPLIED: "Replied",
  QUALIFIED: "Qualified",
  MEETING_BOOKED: "Meeting booked",
  HANDED_OFF: "Handed off",
  NOT_NOW: "Not now",
  DISQUALIFIED: "Disqualified",
};

/** Disqualified requires a reason (spec §4.5). */
export function requiresReason(toStage: Stage): boolean {
  return toStage === "DISQUALIFIED";
}

/** Entering Accepted starts the follow-up cadence. */
export function schedulesFollowups(toStage: Stage): boolean {
  return toStage === "ACCEPTED";
}

/** Leaving the pre-reply cadence cancels any pending follow-ups. */
export function cancelsFollowups(toStage: Stage): boolean {
  return (
    toStage === "REPLIED" ||
    toStage === "QUALIFIED" ||
    toStage === "MEETING_BOOKED" ||
    toStage === "HANDED_OFF" ||
    toStage === "NOT_NOW" ||
    toStage === "DISQUALIFIED"
  );
}
