import { describe, it, expect } from "vitest";
import { auditReportBody, buildAuditPdfHtml } from "@/modules/audit/pdf-template";
import { publicCategoryGroups } from "@/modules/audit/categories";
import type { AuditView, CrawlResult } from "@/modules/audit/types";

/**
 * P1/3b — the internal/public split.
 *
 * The sales PDF is for us and keeps the pitch angle. The public report is for
 * the prospect and must contain facts only. This pins the PDF side; an e2e
 * pins the rendered public page, because that is where the leak actually was.
 */
const PITCH = "Their site is ancient — lead with the mobile failure and push a rebuild.";

const view: AuditView = {
  id: "aud1",
  url: "https://pelda.hu",
  status: "done",
  score: 72,
  verdict: "STRONG",
  checks: [
    { key: "https", label: "HTTPS", pass: true, detail: null },
    { key: "mobile", label: "Mobile layout", pass: false, detail: "no viewport tag" },
  ],
  flags: ["no mobile layout"],
  screenshots: { desktop: "audits/aud1-desktop.png", mobile: "audits/aud1-mobile.png" },
  pitchSummary: PITCH,
  pdfPath: null,
} as unknown as AuditView;

describe("sales PDF keeps everything", () => {
  it("includes the pitch angle", () => {
    expect(buildAuditPdfHtml(view)).toContain("Pitch angle");
    expect(buildAuditPdfHtml(view)).toContain("ancient");
  });

  it("embeds screenshots as data URIs, not app URLs", () => {
    const html = buildAuditPdfHtml(view, {
      shots: { desktop: "data:image/png;base64,AAAA", mobile: "data:image/png;base64,BBBB" },
    });
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
    // Headless Chrome in the worker has no session; an app URL would render
    // as a broken box.
    expect(html).not.toContain("/api/files/");
  });

  it("renders without screenshots rather than emitting empty images", () => {
    const html = buildAuditPdfHtml(view);
    expect(html).not.toContain("<img");
    expect(html).toContain("HTTPS");
  });

  it("escapes a hostile URL rather than injecting markup", () => {
    const nasty = { ...view, url: '"><script>alert(1)</script>' } as AuditView;
    expect(buildAuditPdfHtml(nasty)).not.toContain("<script>alert(1)</script>");
  });
});

describe("report body", () => {
  it("shows the findings", () => {
    const body = auditReportBody(view);
    expect(body).toContain("HTTPS");
    expect(body).toContain("Mobile layout");
  });
});

/**
 * P2/1 — the crawl is an internal tool. Public and self-serve audits are
 * single-page for cost control, so a prospect must never be shown Site
 * structure findings their own report could not contain.
 */
describe("crawl findings stay internal", () => {
  const crawl: CrawlResult = {
    startUrl: "https://pelda.hu/",
    pages: [
      {
        url: "https://pelda.hu/",
        finalUrl: "https://pelda.hu/",
        status: 200,
        redirects: [],
        title: "Kezdőlap",
        metaDescription: "d",
        h1Count: 1,
        bytes: 40_000,
        links: ["https://pelda.hu/halott"],
      },
    ],
    brokenLinks: [
      { from: "https://pelda.hu/", to: "https://pelda.hu/halott", status: 404 },
    ],
    sitemapUrls: [],
    cap: 15,
    discovered: 2,
    robotsSkipped: 0,
    linkCheckTruncated: false,
    deadlineHit: false,
    elapsedMs: 12_000,
  };
  const crawled = {
    ...view,
    checks: [
      ...view.checks,
      { key: "brokenLinks", label: "No broken internal links", pass: false, detail: "1 broken" },
    ],
    crawl,
  } as unknown as AuditView;

  it("puts the per-page detail in the sales PDF", () => {
    const html = buildAuditPdfHtml(crawled);
    expect(html).toContain("Site structure");
    expect(html).toContain("/halott");
    expect(html).toContain("1 of 2 pages crawled");
  });

  it("omits the whole section when the audit was single-page", () => {
    expect(buildAuditPdfHtml(view)).not.toContain("Site structure");
  });

  it("drops the structure category from what the public page groups", () => {
    const groups = publicCategoryGroups(crawled.checks);
    expect(groups.some((g) => g.category === "structure")).toBe(false);
    expect(groups.flatMap((g) => g.checks).some((c) => c.key === "brokenLinks")).toBe(false);
    // The single-page findings are still there — this filters one category,
    // not the report.
    expect(groups.some((g) => g.category === "security")).toBe(true);
  });
});
