import { describe, it, expect } from "vitest";
import {
  followupPlan,
  wakeUpDate,
  shouldAutoNotNow,
  daysInStage,
  FU1_DELAY_DAYS,
  FU2_DELAY_DAYS,
  AUTO_NOT_NOW_DELAY_DAYS,
} from "../../src/modules/pipeline/schedule";
import {
  requiresReason,
  schedulesFollowups,
  cancelsFollowups,
} from "../../src/modules/pipeline/transitions";

const DAY = 86_400_000;

describe("followupPlan (BullMQ delays after Accepted)", () => {
  it("schedules FU1, FU2, and auto Not-now at the configured delays", () => {
    const plan = followupPlan();
    expect(plan.map((p) => p.type)).toEqual(["fu1", "fu2", "auto_notnow"]);
    expect(plan[0].delayMs).toBe(FU1_DELAY_DAYS * DAY);
    expect(plan[1].delayMs).toBe(FU2_DELAY_DAYS * DAY);
    expect(plan[2].delayMs).toBe(AUTO_NOT_NOW_DELAY_DAYS * DAY);
    // FU2 must come after FU1; auto Not-now after FU2.
    expect(plan[1].delayMs).toBeGreaterThan(plan[0].delayMs);
    expect(plan[2].delayMs).toBeGreaterThan(plan[1].delayMs);
  });
});

describe("wakeUpDate (Not now default +6 months)", () => {
  it("advances six months", () => {
    expect(wakeUpDate(new Date("2026-01-15T00:00:00Z")).toISOString()).toBe(
      new Date("2026-07-15T00:00:00Z").toISOString(),
    );
  });
});

describe("shouldAutoNotNow (no reply = not advanced past Accepted)", () => {
  it("is true while still pre-reply", () => {
    expect(shouldAutoNotNow("CONTACTED")).toBe(true);
    expect(shouldAutoNotNow("ACCEPTED")).toBe(true);
  });
  it("is false once the lead has replied or moved on", () => {
    expect(shouldAutoNotNow("REPLIED")).toBe(false);
    expect(shouldAutoNotNow("QUALIFIED")).toBe(false);
    expect(shouldAutoNotNow("NOT_NOW")).toBe(false);
  });
});

describe("daysInStage", () => {
  it("counts whole days since entering the stage", () => {
    const entered = new Date("2026-08-01T00:00:00Z");
    expect(daysInStage(entered, new Date("2026-08-01T10:00:00Z"))).toBe(0);
    expect(daysInStage(entered, new Date("2026-08-09T00:00:00Z"))).toBe(8);
  });
});

describe("transition rules", () => {
  it("requires a reason only for Disqualified", () => {
    expect(requiresReason("DISQUALIFIED")).toBe(true);
    expect(requiresReason("NOT_NOW")).toBe(false);
    expect(requiresReason("CONTACTED")).toBe(false);
  });
  it("schedules follow-ups only when entering Accepted", () => {
    expect(schedulesFollowups("ACCEPTED")).toBe(true);
    expect(schedulesFollowups("CONTACTED")).toBe(false);
  });
  it("cancels pending follow-ups when the lead replies or leaves the cadence", () => {
    expect(cancelsFollowups("REPLIED")).toBe(true);
    expect(cancelsFollowups("NOT_NOW")).toBe(true);
    expect(cancelsFollowups("DISQUALIFIED")).toBe(true);
    expect(cancelsFollowups("ACCEPTED")).toBe(false);
  });
});
