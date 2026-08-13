import { describe, it, expect } from "vitest";
import { analyzeStructure, orphanHints } from "@/modules/audit/structure";
import type { CrawlPage, CrawlResult } from "@/modules/audit/types";

/**
 * The crawl's findings (P2/1). Everything here is pure over a fixture crawl —
 * the point of splitting analysis from fetching is that these rules can be
 * checked without a website.
 */
function page(url: string, over: Partial<CrawlPage> = {}): CrawlPage {
  return {
    url,
    finalUrl: url,
    status: 200,
    redirects: [],
    title: "Kezdőlap",
    metaDescription: "Leírás",
    h1Count: 1,
    bytes: 50_000,
    links: [],
    ...over,
  };
}

function crawl(over: Partial<CrawlResult> = {}): CrawlResult {
  return {
    startUrl: "https://example.hu/",
    pages: [],
    brokenLinks: [],
    sitemapUrls: [],
    cap: 15,
    discovered: 1,
    robotsSkipped: 0,
    linkCheckTruncated: false,
    deadlineHit: false,
    elapsedMs: 1000,
    ...over,
  };
}

const check = (r: ReturnType<typeof analyzeStructure>, key: string) =>
  r.checks.find((c) => c.key === key);

describe("broken links", () => {
  it("fails the check and flags the lead", () => {
    const r = analyzeStructure(
      crawl({
        pages: [page("https://example.hu/")],
        brokenLinks: [
          { from: "https://example.hu/", to: "https://example.hu/arak", status: 404 },
        ],
      }),
    );
    expect(check(r, "brokenLinks")!.pass).toBe(false);
    expect(check(r, "brokenLinks")!.detail).toContain("1");
    expect(r.flags).toContain("broken links");
  });

  it("passes when there are none", () => {
    const r = analyzeStructure(crawl({ pages: [page("https://example.hu/")] }));
    expect(check(r, "brokenLinks")!.pass).toBe(true);
    expect(r.flags).not.toContain("broken links");
  });

  it("says so when the link check was truncated", () => {
    const r = analyzeStructure(
      crawl({
        pages: [page("https://example.hu/")],
        brokenLinks: [{ from: "https://example.hu/", to: "https://example.hu/x", status: 500 }],
        linkCheckTruncated: true,
      }),
    );
    expect(check(r, "brokenLinks")!.detail).toContain("partial");
  });

  it("counts broken links per source page", () => {
    const r = analyzeStructure(
      crawl({
        pages: [page("https://example.hu/"), page("https://example.hu/a", { title: "A" })],
        brokenLinks: [
          { from: "https://example.hu/a", to: "https://example.hu/x", status: 404 },
          { from: "https://example.hu/a", to: "https://example.hu/y", status: 404 },
        ],
      }),
    );
    expect(r.rows.find((x) => x.path === "/a")!.brokenLinksOut).toBe(2);
    expect(r.rows.find((x) => x.path === "/")!.brokenLinksOut).toBe(0);
  });
});

describe("cross-page checks", () => {
  it("catches duplicate titles and flags them", () => {
    const r = analyzeStructure(
      crawl({
        pages: [
          page("https://example.hu/"),
          page("https://example.hu/a", { title: "Kezdőlap" }),
        ],
      }),
    );
    expect(check(r, "duplicateTitles")!.pass).toBe(false);
    expect(r.flags).toContain("duplicate titles");
    expect(r.rows.every((x) => x.titleDuplicate)).toBe(true);
  });

  it("compares titles case- and whitespace-insensitively", () => {
    const r = analyzeStructure(
      crawl({
        pages: [
          page("https://example.hu/"),
          page("https://example.hu/a", { title: "  KEZDŐLAP " }),
        ],
      }),
    );
    expect(check(r, "duplicateTitles")!.pass).toBe(false);
  });

  it("reports missing titles separately from duplicates", () => {
    const r = analyzeStructure(
      crawl({
        pages: [
          page("https://example.hu/"),
          page("https://example.hu/a", { title: null }),
          page("https://example.hu/b", { title: "B" }),
        ],
      }),
    );
    expect(check(r, "pageTitles")!.pass).toBe(false);
    expect(check(r, "pageTitles")!.detail).toContain("1");
    expect(check(r, "duplicateTitles")!.pass).toBe(true);
  });

  it("catches duplicate meta descriptions", () => {
    const r = analyzeStructure(
      crawl({
        pages: [page("https://example.hu/"), page("https://example.hu/a", { title: "A" })],
      }),
    );
    expect(check(r, "duplicateMetaDescriptions")!.pass).toBe(false);
  });

  it("wants exactly one H1 per page", () => {
    const r = analyzeStructure(
      crawl({
        pages: [
          page("https://example.hu/"),
          page("https://example.hu/a", { title: "A", metaDescription: "a", h1Count: 3 }),
        ],
      }),
    );
    expect(check(r, "h1Consistency")!.pass).toBe(false);
    expect(check(r, "h1Consistency")!.detail).toContain("1");
  });

  it("emits nothing cross-page when only one page was reachable", () => {
    const r = analyzeStructure(
      crawl({
        pages: [page("https://example.hu/"), page("https://example.hu/a", { status: 500 })],
      }),
    );
    expect(check(r, "duplicateTitles")).toBeUndefined();
    expect(check(r, "h1Consistency")).toBeUndefined();
    // The link and redirect checks stand on their own and still run.
    expect(check(r, "brokenLinks")).toBeDefined();
  });
});

describe("redirect chains", () => {
  it("flags two or more hops, not a single redirect", () => {
    const one = analyzeStructure(
      crawl({ pages: [page("https://example.hu/", { redirects: ["http://example.hu/"] })] }),
    );
    expect(check(one, "redirectChains")!.pass).toBe(true);

    const two = analyzeStructure(
      crawl({
        pages: [
          page("https://example.hu/", {
            redirects: ["http://example.hu", "http://www.example.hu"],
          }),
        ],
      }),
    );
    expect(check(two, "redirectChains")!.pass).toBe(false);
  });
});

describe("page weight outliers", () => {
  it("needs both twice the median and 300 KB", () => {
    const modest = analyzeStructure(
      crawl({
        pages: [
          page("https://example.hu/", { bytes: 20_000 }),
          page("https://example.hu/a", { title: "A", metaDescription: "a", bytes: 25_000 }),
          page("https://example.hu/b", { title: "B", metaDescription: "b", bytes: 90_000 }),
        ],
      }),
    );
    // 90 KB is over twice the median but nowhere near the floor.
    expect(check(modest, "pageWeightOutliers")!.pass).toBe(true);

    const heavy = analyzeStructure(
      crawl({
        pages: [
          page("https://example.hu/", { bytes: 20_000 }),
          page("https://example.hu/a", { title: "A", metaDescription: "a", bytes: 25_000 }),
          page("https://example.hu/b", { title: "B", metaDescription: "b", bytes: 800_000 }),
        ],
      }),
    );
    expect(check(heavy, "pageWeightOutliers")!.pass).toBe(false);
    expect(heavy.rows.find((r) => r.path === "/b")!.weightOutlier).toBe(true);
  });

  it("is not emitted below three measurable pages", () => {
    const r = analyzeStructure(
      crawl({
        pages: [page("https://example.hu/"), page("https://example.hu/a", { title: "A" })],
      }),
    );
    expect(check(r, "pageWeightOutliers")).toBeUndefined();
  });
});

describe("orphan hints", () => {
  const withSitemap = () =>
    crawl({
      pages: [
        page("https://example.hu/", { links: ["https://example.hu/a"] }),
        page("https://example.hu/a", { title: "A", metaDescription: "a" }),
      ],
      sitemapUrls: ["https://example.hu/", "https://example.hu/a", "https://example.hu/rejtett"],
      discovered: 2,
    });

  it("still reports a sitemap page as orphaned when the crawl reached it that way", () => {
    // The crawler opens sitemap entries directly. Having visited one says
    // nothing about whether anything links to it.
    const c = crawl({
      pages: [
        page("https://example.hu/", { links: [] }),
        page("https://example.hu/rejtett", { title: "R", metaDescription: "r" }),
      ],
      sitemapUrls: ["https://example.hu/", "https://example.hu/rejtett"],
      discovered: 2,
    });
    expect(orphanHints(c)).toEqual(["https://example.hu/rejtett"]);
  });

  it("names sitemap pages nothing links to", () => {
    expect(orphanHints(withSitemap())).toEqual(["https://example.hu/rejtett"]);
    const r = analyzeStructure(withSitemap());
    expect(check(r, "orphanPages")!.pass).toBe(false);
    expect(r.orphans).toEqual(["https://example.hu/rejtett"]);
  });

  it("ignores the trailing slash and www when matching", () => {
    const c = crawl({
      pages: [page("https://example.hu/", { links: ["https://www.example.hu/a/"] })],
      sitemapUrls: ["https://example.hu/a"],
      discovered: 1,
    });
    expect(orphanHints(c)).toEqual([]);
  });

  it("stays silent when the crawl was truncated — we simply did not look", () => {
    const truncated = { ...withSitemap(), discovered: 40 };
    const r = analyzeStructure(truncated);
    expect(check(r, "orphanPages")).toBeUndefined();
    expect(r.orphans).toEqual([]);

    const timedOut = { ...withSitemap(), deadlineHit: true };
    expect(analyzeStructure(timedOut).orphans).toEqual([]);
  });
});
