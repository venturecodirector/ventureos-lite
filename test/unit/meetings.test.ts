import { describe, it, expect } from "vitest";
import {
  shouldGenerateBrief,
  claimBriefTransition,
  calendarFailureActivity,
} from "../../src/modules/meetings/logic";

describe("brief generation is idempotent per meeting (spec §4.8)", () => {
  it("only generates when no brief exists yet", () => {
    expect(shouldGenerateBrief("none")).toBe(true);
    expect(shouldGenerateBrief("generating")).toBe(false);
    expect(shouldGenerateBrief("done")).toBe(false);
    expect(shouldGenerateBrief("error")).toBe(false);
  });

  it("the atomic claim proceeds exactly once (one Claude call per booking)", () => {
    expect(claimBriefTransition("none")).toEqual({ claim: true, next: "generating" });
    // A second entry into Meeting-booked cannot re-claim:
    expect(claimBriefTransition("generating")).toEqual({ claim: false, next: "generating" });
    expect(claimBriefTransition("done")).toEqual({ claim: false, next: "done" });
    expect(claimBriefTransition("error")).toEqual({ claim: false, next: "error" });
  });
});

describe("calendar failure lands in Today Queue (spec §4.8)", () => {
  it("produces a calendar_failed Activity carrying the meeting + error", () => {
    const a = calendarFailureActivity({
      meetingId: "m1",
      leadId: "L1",
      error: "invalid_grant",
    });
    expect(a.type).toBe("calendar_failed");
    expect(a.leadId).toBe("L1");
    expect(a.payload).toMatchObject({ meetingId: "m1", error: "invalid_grant" });
  });
});
