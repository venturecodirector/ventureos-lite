import { describe, it, expect } from "vitest";
import { canEnterContacted, SCORE_GATE_THRESHOLD } from "../../src/lib/scoring";
import { assessIcp, computeIcpScore } from "../../src/modules/leads/scoring";

describe("score gate", () => {
  it("blocks leads below the default threshold from Contacted", () => {
    expect(canEnterContacted(2)).toBe(false);
  });

  it("allows leads at or above the default threshold", () => {
    expect(canEnterContacted(SCORE_GATE_THRESHOLD)).toBe(true);
    expect(canEnterContacted(5)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(canEnterContacted(3, 4)).toBe(false);
    expect(canEnterContacted(4, 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1/1d — unknown handling
// ---------------------------------------------------------------------------

describe("assessIcp: unknown is not the same as zero", () => {
  it("counts a fully judged breakdown exactly like the plain sum", () => {
    const b = {
      segment_fit: 1,
      trigger_signal: 0,
      decision_maker: 1,
      active_profile: 0,
      personal_hook: 1,
    } as const;
    const a = assessIcp(b);
    expect(a.score).toBe(computeIcpScore(b));
    expect(a.incomplete).toBe(false);
    expect(a.unknown).toEqual([]);
    expect(a.potentialScore).toBe(3);
  });

  it("keeps unknowns out of the score but names them", () => {
    const a = assessIcp({
      segment_fit: 1,
      trigger_signal: "unknown",
      decision_maker: 1,
      active_profile: "unknown",
      personal_hook: 0,
    });
    // The gate stays conservative: unknown contributes nothing.
    expect(a.score).toBe(2);
    expect(a.unknown).toEqual(["trigger_signal", "active_profile"]);
    expect(a.known).toEqual(["segment_fit", "decision_maker", "personal_hook"]);
    expect(a.incomplete).toBe(true);
  });

  it("shows how high the lead could reach once the gaps are filled", () => {
    const a = assessIcp({ segment_fit: 1, trigger_signal: "unknown" });
    // 1 known point + 4 missing criteria.
    expect(a.score).toBe(1);
    expect(a.potentialScore).toBe(5);
  });

  it("treats an omitted criterion as unknown, not as zero", () => {
    const a = assessIcp({ segment_fit: 1 });
    expect(a.unknown).toHaveLength(4);
    expect(a.incomplete).toBe(true);
  });

  it("treats junk values as unknown rather than trusting them", () => {
    const a = assessIcp({
      segment_fit: 2 as unknown as 1,
      trigger_signal: null as unknown as 0,
      decision_maker: "yes" as unknown as 1,
    });
    expect(a.score).toBe(0);
    expect(a.unknown).toHaveLength(5);
  });

  it("distinguishes an all-zero judgement from an all-unknown one", () => {
    const judged = assessIcp({
      segment_fit: 0,
      trigger_signal: 0,
      decision_maker: 0,
      active_profile: 0,
      personal_hook: 0,
    });
    const blank = assessIcp({});
    expect(judged.score).toBe(blank.score); // both 0 …
    expect(judged.incomplete).toBe(false); // … but only one is a verdict
    expect(blank.incomplete).toBe(true);
    expect(judged.potentialScore).toBe(0);
    expect(blank.potentialScore).toBe(5);
  });
});
