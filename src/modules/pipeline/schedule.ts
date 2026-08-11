import type { Stage } from "@prisma/client";

/**
 * Follow-up cadence (spec §4.5–4.6). Task-level automations only — never
 * messaging. After a lead is Accepted: FU1, then FU2, then (if still no reply)
 * auto Not-now with a +6-month wake-up. Values sit at the low end of the spec's
 * ranges and are kept as named constants so they're easy to tune and test.
 */
export const FU1_DELAY_DAYS = 2; // spec: +2–3d after Accepted
export const FU2_DELAY_DAYS = 7; // spec: +7–10d
export const AUTO_NOT_NOW_DELAY_DAYS = 14; // after FU2 without reply
export const NOT_NOW_WAKE_MONTHS = 6;

const DAY_MS = 86_400_000;

export type FollowupType = "fu1" | "fu2" | "auto_notnow";

export interface FollowupJobSpec {
  type: FollowupType;
  delayMs: number;
}

export function followupPlan(): FollowupJobSpec[] {
  return [
    { type: "fu1", delayMs: FU1_DELAY_DAYS * DAY_MS },
    { type: "fu2", delayMs: FU2_DELAY_DAYS * DAY_MS },
    { type: "auto_notnow", delayMs: AUTO_NOT_NOW_DELAY_DAYS * DAY_MS },
  ];
}

export function wakeUpDate(from: Date, months = NOT_NOW_WAKE_MONTHS): Date {
  // UTC arithmetic so the result is stable across timezones / DST.
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// A lead is still in the follow-up cadence (i.e. "no reply yet") while it sits
// at Contacted or Accepted. Once it reaches Replied or beyond, the cadence ends.
const PRE_REPLY_STAGES: Stage[] = ["CONTACTED", "ACCEPTED"];

export function shouldAutoNotNow(stage: Stage): boolean {
  return PRE_REPLY_STAGES.includes(stage);
}

export function daysInStage(stageEnteredAt: Date, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - stageEnteredAt.getTime()) / DAY_MS),
  );
}
