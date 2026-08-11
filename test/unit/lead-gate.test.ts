import { describe, it, expect } from "vitest";
import { assertCanEnterStage, ScoreGateError } from "../../src/modules/leads/gate";

const THRESHOLD = 3;

describe("score gate (server-side enforcement, spec §4.5 / CLAUDE.md #5)", () => {
  it("blocks entering Contacted below the threshold", () => {
    expect(() =>
      assertCanEnterStage({ toStage: "CONTACTED", score: 2, threshold: THRESHOLD }),
    ).toThrow(ScoreGateError);
  });

  it("blocks entering Contacted with no score yet", () => {
    expect(() =>
      assertCanEnterStage({ toStage: "CONTACTED", score: null, threshold: THRESHOLD }),
    ).toThrow(ScoreGateError);
  });

  it("allows entering Contacted at or above the threshold", () => {
    expect(() =>
      assertCanEnterStage({ toStage: "CONTACTED", score: 3, threshold: THRESHOLD }),
    ).not.toThrow();
    expect(() =>
      assertCanEnterStage({ toStage: "CONTACTED", score: 5, threshold: THRESHOLD }),
    ).not.toThrow();
  });

  it("does not gate non-Contacted transitions", () => {
    expect(() =>
      assertCanEnterStage({ toStage: "RESEARCHED", score: 0, threshold: THRESHOLD }),
    ).not.toThrow();
    expect(() =>
      assertCanEnterStage({ toStage: "DISQUALIFIED", score: 0, threshold: THRESHOLD }),
    ).not.toThrow();
  });

  it("carries lead/score/threshold context on the error", () => {
    try {
      assertCanEnterStage({
        toStage: "CONTACTED",
        score: 1,
        threshold: THRESHOLD,
        leadId: "L1",
      });
      throw new Error("expected ScoreGateError");
    } catch (e) {
      expect(e).toBeInstanceOf(ScoreGateError);
      const g = e as ScoreGateError;
      expect(g.score).toBe(1);
      expect(g.threshold).toBe(3);
      expect(g.leadId).toBe("L1");
    }
  });
});
