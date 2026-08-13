import { describe, it, expect } from "vitest";
import {
  scoreByCategory,
  overallFromCategories,
  weightsFrom,
  DEFAULT_CATEGORY_WEIGHTS,
  AUDIT_CATEGORIES,
  CHECK_META,
} from "@/modules/audit/categories";
import type { AuditCheck } from "@/modules/audit/types";

const check = (key: string, pass: boolean): AuditCheck => ({ key, label: key, pass });

describe("scoreByCategory", () => {
  it("puts each check in exactly one category", () => {
    const scores = scoreByCategory([check("https", true), check("spf", false)]);
    const security = scores.find((s) => s.category === "security")!;
    const email = scores.find((s) => s.category === "email")!;
    expect(security.total).toBe(1);
    expect(email.total).toBe(1);
    expect(scores.filter((s) => s.total > 0)).toHaveLength(2);
  });

  it("reports the share of WEIGHT that failed, not the count", () => {
    // https weighs 3, hsts weighs 1: failing only https is 75% of the weight.
    const scores = scoreByCategory([check("https", false), check("hsts", true)]);
    expect(scores.find((s) => s.category === "security")!.subscore).toBe(75);
  });

  it("scores an all-passing category 0 and an all-failing one 100", () => {
    const good = scoreByCategory([check("spf", true), check("dmarc", true)]);
    const bad = scoreByCategory([check("spf", false), check("dmarc", false)]);
    expect(good.find((s) => s.category === "email")!.subscore).toBe(0);
    expect(bad.find((s) => s.category === "email")!.subscore).toBe(100);
  });

  it("returns null — not zero — for a category with nothing to measure", () => {
    const scores = scoreByCategory([check("https", true)]);
    const email = scores.find((s) => s.category === "email")!;
    expect(email.subscore).toBeNull();
    expect(email.total).toBe(0);
  });

  it("ignores an unregistered check rather than inventing a category", () => {
    const scores = scoreByCategory([check("something_new", false)]);
    expect(scores.every((s) => s.total === 0)).toBe(true);
  });

  it("always returns every category, in a stable order", () => {
    const scores = scoreByCategory([]);
    expect(scores.map((s) => s.category)).toEqual([...AUDIT_CATEGORIES]);
  });
});

describe("overallFromCategories", () => {
  it("weights categories against each other", () => {
    const scores = scoreByCategory([
      check("https", false), // security 100
      check("spf", true), // email 0
    ]);
    const overall = overallFromCategories(scores, {
      ...DEFAULT_CATEGORY_WEIGHTS,
      security: 30,
      email: 10,
    });
    // 100*30 + 0*10 over 40 = 75
    expect(overall).toBe(75);
  });

  it("shrinks the divisor for categories that could not be measured", () => {
    // Only security measured, and it failed entirely: the score is 100, not
    // 100 * securityWeight / totalOfAllWeights.
    const scores = scoreByCategory([check("https", false)]);
    expect(overallFromCategories(scores)).toBe(100);
  });

  it("is 0 when nothing at all could be measured", () => {
    expect(overallFromCategories(scoreByCategory([]))).toBe(0);
  });

  it("a perfect site scores 0 opportunity", () => {
    const scores = scoreByCategory([check("https", true), check("spf", true)]);
    expect(overallFromCategories(scores)).toBe(0);
  });
});

describe("weightsFrom", () => {
  it("falls back to the defaults", () => {
    expect(weightsFrom(null)).toEqual(DEFAULT_CATEGORY_WEIGHTS);
    expect(weightsFrom({})).toEqual(DEFAULT_CATEGORY_WEIGHTS);
  });

  it("takes only the keys a workspace overrode", () => {
    const w = weightsFrom({ categoryWeights: { legal: 40 } });
    expect(w.legal).toBe(40);
    expect(w.seo).toBe(DEFAULT_CATEGORY_WEIGHTS.seo);
  });

  it("refuses nonsense values", () => {
    const w = weightsFrom({ categoryWeights: { legal: -5, seo: "lots", email: NaN } });
    expect(w.legal).toBe(DEFAULT_CATEGORY_WEIGHTS.legal);
    expect(w.seo).toBe(DEFAULT_CATEGORY_WEIGHTS.seo);
    expect(w.email).toBe(DEFAULT_CATEGORY_WEIGHTS.email);
  });

  it("allows a category to be switched off with 0", () => {
    expect(weightsFrom({ categoryWeights: { accessibility: 0 } }).accessibility).toBe(0);
  });
});

describe("the registry itself", () => {
  it("only maps checks onto real categories", () => {
    for (const [key, meta] of Object.entries(CHECK_META)) {
      expect(AUDIT_CATEGORIES, `${key} has a bogus category`).toContain(meta.category);
    }
  });

  it("gives every category at least one check to measure", () => {
    for (const category of AUDIT_CATEGORIES) {
      const owned = Object.values(CHECK_META).filter((m) => m.category === category);
      expect(owned.length, `${category} has no checks`).toBeGreaterThan(0);
    }
  });
});
