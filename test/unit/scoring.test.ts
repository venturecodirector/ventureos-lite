import { describe, it, expect } from "vitest";
import { canEnterContacted, SCORE_GATE_THRESHOLD } from "../../src/lib/scoring";

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
