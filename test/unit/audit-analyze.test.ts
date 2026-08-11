import { describe, it, expect } from "vitest";
import { analyzeAudit, verdictFor } from "../../src/modules/audit/analyze";
import { DEFAULT_AUDIT_THRESHOLDS } from "../../src/modules/audit/config";
import type { PageProbe } from "../../src/modules/audit/types";

const NOW = new Date("2026-08-11T00:00:00Z");

const strongSite: PageProbe = {
  url: "https://good.example",
  finalUrl: "https://good.example",
  isHttps: true,
  statusOk: true,
  hasViewport: true,
  title: "Good Co",
  metaDescription: "We do good things",
  h1Count: 1,
  imgTotal: 4,
  imgWithAlt: 4,
  hasSitemap: true,
  hasRobots: true,
  copyrightYear: 2026,
  hasPhone: true,
  hasEmail: true,
  hasForm: true,
  hasBooking: true,
  hasCookieBanner: true,
  pageWeightBytes: 500_000,
  psi: { performance: 95, seo: 95, accessibility: 95, bestPractices: 95 },
  screenshots: {},
};

const weakSite: PageProbe = {
  ...strongSite,
  url: "https://weak.example",
  finalUrl: "https://weak.example",
  hasViewport: false, // no mobile
  metaDescription: null, // weak SEO
  imgTotal: 10,
  imgWithAlt: 2, // 20% alt coverage
  hasRobots: false,
  copyrightYear: 2019, // outdated
  hasBooking: false, // no online booking
  hasCookieBanner: false, // GDPR gap
  pageWeightBytes: 4_200_000, // heavy
  psi: { performance: 28, seo: 40, accessibility: 55, bestPractices: 60 },
};

describe("verdictFor", () => {
  it("maps score to STRONG / POSSIBLE / SKIP by thresholds", () => {
    expect(verdictFor(85)).toBe("STRONG");
    expect(verdictFor(70)).toBe("STRONG");
    expect(verdictFor(69)).toBe("POSSIBLE");
    expect(verdictFor(40)).toBe("POSSIBLE");
    expect(verdictFor(39)).toBe("SKIP");
  });
});

describe("analyzeAudit", () => {
  it("scores a strong (healthy) site low and verdicts SKIP with no flags", () => {
    const a = analyzeAudit(strongSite, DEFAULT_AUDIT_THRESHOLDS, NOW);
    expect(a.score).toBeLessThan(DEFAULT_AUDIT_THRESHOLDS.verdict.possible);
    expect(a.verdict).toBe("SKIP");
    expect(a.flags).toHaveLength(0);
    // every check passes
    expect(a.checks.every((c) => c.pass)).toBe(true);
  });

  it("scores a weak site high and verdicts STRONG with opportunity flags", () => {
    const a = analyzeAudit(weakSite, DEFAULT_AUDIT_THRESHOLDS, NOW);
    expect(a.score).toBeGreaterThanOrEqual(DEFAULT_AUDIT_THRESHOLDS.verdict.strong);
    expect(a.verdict).toBe("STRONG");
    expect(a.flags).toEqual(
      expect.arrayContaining([
        "no mobile",
        "slow site",
        "outdated website",
        "no online booking",
        "GDPR gap",
        "weak SEO",
      ]),
    );
  });

  it("fails alt coverage below 50% but passes when there are no images", () => {
    const alt = analyzeAudit(weakSite, DEFAULT_AUDIT_THRESHOLDS, NOW).checks.find(
      (c) => c.key === "altCoverage",
    );
    expect(alt?.pass).toBe(false);
    const noImgs = analyzeAudit(
      { ...strongSite, imgTotal: 0, imgWithAlt: 0 },
      DEFAULT_AUDIT_THRESHOLDS,
      NOW,
    ).checks.find((c) => c.key === "altCoverage");
    expect(noImgs?.pass).toBe(true);
  });

  it("clamps the score to 0–100", () => {
    const a = analyzeAudit(weakSite, DEFAULT_AUDIT_THRESHOLDS, NOW);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
  });
});
