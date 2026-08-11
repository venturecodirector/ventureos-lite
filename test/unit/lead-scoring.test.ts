import { describe, it, expect } from "vitest";
import {
  computeIcpScore,
  ICP_CRITERIA,
  MAX_ICP_SCORE,
} from "../../src/modules/leads/scoring";

describe("computeIcpScore (ICP scoring math, spec §4.5)", () => {
  it("sums the five 1-point criteria to a max of 5", () => {
    expect(
      computeIcpScore({
        segment_fit: 1,
        trigger_signal: 1,
        decision_maker: 1,
        active_profile: 1,
        personal_hook: 1,
      }),
    ).toBe(5);
    expect(MAX_ICP_SCORE).toBe(5);
    expect(ICP_CRITERIA).toHaveLength(5);
  });

  it("scores zero when nothing matches", () => {
    expect(
      computeIcpScore({
        segment_fit: 0,
        trigger_signal: 0,
        decision_maker: 0,
        active_profile: 0,
        personal_hook: 0,
      }),
    ).toBe(0);
  });

  it("scores the number of matched criteria", () => {
    expect(
      computeIcpScore({
        segment_fit: 1,
        trigger_signal: 1,
        decision_maker: 1,
        active_profile: 0,
        personal_hook: 0,
      }),
    ).toBe(3);
  });
});
