import { describe, it, expect } from "vitest";
import {
  computeLineTotal,
  computeQuoteTotals,
  type QuoteItem,
} from "../../src/modules/documents/quote-math";

describe("computeLineTotal (integer HUF, house-rule presets)", () => {
  it("production markup +30%", () => {
    expect(computeLineTotal(1_400_000, "production")).toBe(1_820_000);
    expect(computeLineTotal(220_000, "production")).toBe(286_000);
  });
  it("pass-through +15%", () => {
    expect(computeLineTotal(180_000, "passthrough")).toBe(207_000);
  });
  it("no preset", () => {
    expect(computeLineTotal(500_000, "none")).toBe(500_000);
  });
  it("rounds to whole forints (never floats)", () => {
    expect(computeLineTotal(101, "passthrough")).toBe(116); // 116.15 → 116
    expect(Number.isInteger(computeLineTotal(101, "passthrough"))).toBe(true);
  });
});

describe("computeQuoteTotals (net + VAT + gross)", () => {
  it("sums line totals, computes VAT, and gross — all integer forints", () => {
    const items: QuoteItem[] = [
      { description: "Website development", baseNet: 1_400_000, preset: "production" },
      { description: "SEO technical setup", baseNet: 220_000, preset: "production" },
      { description: "Hosting & photo", baseNet: 180_000, preset: "passthrough" },
    ];
    const t = computeQuoteTotals(items, 27);
    expect(t.net).toBe(2_313_000);
    expect(t.vat).toBe(624_510);
    expect(t.gross).toBe(2_937_510);
    expect(Number.isInteger(t.vat)).toBe(true);
  });
  it("empty items → zeros", () => {
    expect(computeQuoteTotals([], 27)).toEqual({ net: 0, vat: 0, gross: 0 });
  });
});
