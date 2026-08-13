import { describe, it, expect } from "vitest";
import { analyzeAudit } from "@/modules/audit/analyze";
import { scoreByCategory } from "@/modules/audit/categories";
import type { PageProbe } from "@/modules/audit/types";

/**
 * P1/3c fixtures. The property that matters most is the difference between
 * "measured and failed" and "not measured": a DNS timeout must not read as a
 * missing SPF record, and an unmeasured category must not score 0.
 */
function probe(over: Partial<PageProbe> = {}): PageProbe {
  return {
    url: "https://pelda.hu",
    finalUrl: "https://pelda.hu",
    isHttps: true,
    statusOk: true,
    hasViewport: true,
    title: "Pelda",
    metaDescription: "Leírás",
    h1Count: 1,
    imgTotal: 4,
    imgWithAlt: 4,
    hasSitemap: true,
    hasRobots: true,
    copyrightYear: new Date().getUTCFullYear(),
    hasPhone: true,
    hasEmail: true,
    hasForm: true,
    hasBooking: true,
    hasCookieBanner: true,
    pageWeightBytes: 500_000,
    psi: null,
    screenshots: {},
    ...over,
  };
}

const keys = (p: PageProbe) => analyzeAudit(p).checks.map((c) => c.key);
const find = (p: PageProbe, key: string) => analyzeAudit(p).checks.find((c) => c.key === key);

describe("signals that were not measured", () => {
  it("emit no check at all", () => {
    const k = keys(probe());
    for (const key of ["spf", "dmarc", "hsts", "csp", "sslExpiry", "a11yCritical"]) {
      expect(k, `${key} should be absent when unmeasured`).not.toContain(key);
    }
  });

  it("leave their category unmeasured rather than scoring it 0", () => {
    const scores = scoreByCategory(analyzeAudit(probe()).checks);
    expect(scores.find((s) => s.category === "email")!.subscore).toBeNull();
  });
});

describe("security signals", () => {
  it("records a missing HSTS as a failure once measured", () => {
    expect(find(probe({ hsts: false }), "hsts")!.pass).toBe(false);
    expect(find(probe({ hsts: true }), "hsts")!.pass).toBe(true);
  });

  it("fails a certificate expiring inside 30 days, and says how long is left", () => {
    const soon = find(probe({ sslDaysLeft: 9 }), "sslExpiry")!;
    expect(soon.pass).toBe(false);
    expect(soon.detail).toBe("9 days left");
    expect(find(probe({ sslDaysLeft: 90 }), "sslExpiry")!.pass).toBe(true);
  });

  it("calls an already-expired certificate expired", () => {
    expect(find(probe({ sslDaysLeft: -3 }), "sslExpiry")!.detail).toBe("expired");
  });

  it("inverts mixed content — finding it is the failure", () => {
    expect(find(probe({ mixedContent: true }), "mixedContent")!.pass).toBe(false);
    expect(find(probe({ mixedContent: false }), "mixedContent")!.pass).toBe(true);
  });
});

describe("email hygiene", () => {
  it("passes only with both records present", () => {
    const p = probe({ spf: true, dmarc: false });
    expect(find(p, "spf")!.pass).toBe(true);
    expect(find(p, "dmarc")!.pass).toBe(false);
    const email = scoreByCategory(analyzeAudit(p).checks).find((s) => s.category === "email")!;
    expect(email.subscore).toBe(50);
  });
});

describe("Hungarian legal", () => {
  it("only expects ÁSZF from a webshop", () => {
    expect(keys(probe({ hasAszf: false, isWebshop: false }))).not.toContain("aszf");
    expect(keys(probe({ hasAszf: false, isWebshop: true }))).toContain("aszf");
  });

  it("checks impresszum and the privacy notice independently", () => {
    const p = probe({ hasImpresszum: true, hasPrivacyPolicy: false });
    expect(find(p, "impresszum")!.pass).toBe(true);
    expect(find(p, "privacyPolicy")!.pass).toBe(false);
  });
});

describe("findability and conversion", () => {
  it("reports the sitemap URL count", () => {
    expect(find(probe({ sitemapUrlCount: 42 }), "sitemap")!.detail).toBe("42 URLs");
    expect(find(probe({ sitemapUrlCount: 0 }), "sitemap")!.pass).toBe(false);
  });

  it("checks click-to-call and a contact form separately from 'some contact'", () => {
    const p = probe({ hasPhone: false, hasForm: true });
    expect(find(p, "clickToCall")!.pass).toBe(false);
    expect(find(p, "contactForm")!.pass).toBe(true);
  });
});

describe("accessibility", () => {
  it("separates critical from serious violations", () => {
    const p = probe({
      a11y: { critical: 2, serious: 1, moderate: 0, minor: 5, top: ["Contrast too low"] },
    });
    expect(find(p, "a11yCritical")!.pass).toBe(false);
    expect(find(p, "a11yCritical")!.detail).toBe("2 critical");
    expect(find(p, "a11ySerious")!.pass).toBe(false);
  });

  it("passes a clean axe run", () => {
    const p = probe({ a11y: { critical: 0, serious: 0, moderate: 0, minor: 0, top: [] } });
    expect(find(p, "a11yCritical")!.pass).toBe(true);
    const a11y = scoreByCategory(analyzeAudit(p).checks).find((s) => s.category === "accessibility")!;
    expect(a11y.subscore).toBe(0);
  });
});

describe("a thoroughly bad site", () => {
  it("scores high across the failing categories", () => {
    const bad = probe({
      isHttps: false,
      hsts: false,
      csp: false,
      xContentTypeOptions: false,
      xFrameOptions: false,
      mixedContent: true,
      spf: false,
      dmarc: false,
      hasImpresszum: false,
      hasPrivacyPolicy: false,
      hasCookieBanner: false,
    });
    const scores = scoreByCategory(analyzeAudit(bad).checks);
    expect(scores.find((s) => s.category === "security")!.subscore).toBeGreaterThan(70);
    expect(scores.find((s) => s.category === "email")!.subscore).toBe(100);
    expect(scores.find((s) => s.category === "legal")!.subscore).toBeGreaterThan(70);
  });
});

describe("the check list itself", () => {
  it("never contains the same key twice", () => {
    // A duplicate is counted twice by the category scorer and rendered twice.
    const full = probe({
      hsts: true,
      csp: true,
      spf: true,
      dmarc: true,
      sitemapUrlCount: 12,
      hasImpresszum: true,
      hasPrivacyPolicy: true,
      hasAszf: true,
      isWebshop: true,
      hasOpenGraph: true,
      hasCanonical: true,
      hasSchemaOrg: true,
      headingHierarchyOk: true,
      hasAnalytics: true,
      mixedContent: false,
      httpsRedirect: true,
      sslDaysLeft: 60,
      xContentTypeOptions: true,
      xFrameOptions: true,
      a11y: { critical: 0, serious: 0, moderate: 0, minor: 0, top: [] },
    });
    const all = analyzeAudit(full).checks.map((c) => c.key);
    expect(new Set(all).size).toBe(all.length);
  });
});
