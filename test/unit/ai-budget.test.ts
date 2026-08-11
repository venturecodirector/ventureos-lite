import { describe, it, expect } from "vitest";
import { assertWithinBudget, BudgetExceededError } from "../../src/lib/ai/budget";

describe("assertWithinBudget (cap rejection)", () => {
  it("passes when spend is below the cap", () => {
    expect(() =>
      assertWithinBudget({ workspaceId: "w", spentUsd: 0.5, capUsd: 2 }),
    ).not.toThrow();
  });

  it("throws BudgetExceededError once spend reaches the cap", () => {
    expect(() =>
      assertWithinBudget({ workspaceId: "w", spentUsd: 2, capUsd: 2 }),
    ).toThrow(BudgetExceededError);
  });

  it("throws when over the cap and carries workspace/spent/cap context", () => {
    try {
      assertWithinBudget({ workspaceId: "w", spentUsd: 2.5, capUsd: 2 });
      throw new Error("expected BudgetExceededError");
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const be = e as BudgetExceededError;
      expect(be.workspaceId).toBe("w");
      expect(be.spentUsd).toBe(2.5);
      expect(be.capUsd).toBe(2);
    }
  });
});
