import { describe, it, expect } from "vitest";
import { computeCostUsd } from "../../src/lib/ai/cost";

describe("computeCostUsd (budget math)", () => {
  it("prices sonnet input + output per 1M tokens", () => {
    // 1000*$3 + 500*$15 per 1M = (3000 + 7500)/1e6 = $0.0105
    const c = computeCostUsd("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(c).toBeCloseTo(0.0105, 10);
  });

  it("prices haiku cheaper than sonnet", () => {
    // 1000*$1 + 200*$5 per 1M = (1000 + 1000)/1e6 = $0.002
    const c = computeCostUsd("claude-haiku-4-5", {
      input_tokens: 1000,
      output_tokens: 200,
    });
    expect(c).toBeCloseTo(0.002, 10);
  });

  it("prices cache reads at 0.1x and cache writes at 1.25x input rate", () => {
    // 1000*3 + 2000*3*0.1 + 1000*3*1.25 + 500*15 = 3000+600+3750+7500 = 14850 → $0.01485
    const c = computeCostUsd("claude-sonnet-4-6", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 1000,
    });
    expect(c).toBeCloseTo(0.01485, 10);
  });

  it("treats missing/zero cache fields as zero cost", () => {
    expect(
      computeCostUsd("claude-haiku-4-5", { input_tokens: 0, output_tokens: 0 }),
    ).toBe(0);
  });
});
