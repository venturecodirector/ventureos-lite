/**
 * Site-structure analysis over a crawl (P2/1).
 *
 * A single-page audit can only ever say things about one page. Most of what
 * actually costs a small business traffic lives between pages: a dead link in
 * the footer, six pages sharing one title, a product page nobody links to.
 * This turns the crawl into those findings.
 *
 * Pure over CrawlResult — no browser, no network, no database — so every rule
 * here is testable against a fixture.
 *
 * DELIBERATELY UNSCORED. These checks emit no weight into the opportunity
 * score, because a crawled audit and a single-page audit of the same site must
 * remain comparable: the crawl is a toggle, and if it moved the number, the
 * re-audit delta (P2/5) would report "the site got worse" when all that
 * changed was how hard we looked. They produce evidence rows and two
 * opportunity flags instead.
 */
import type { AuditCheck, CrawlResult, CrawlPage } from "./types";

/** A page as the report shows it, with the cross-page verdicts resolved. */
export interface StructureRow {
  url: string;
  /** Path only, for a table that has to fit on a PDF page. */
  path: string;
  status: number | null;
  title: string | null;
  titleDuplicate: boolean;
  metaDescription: string | null;
  metaDuplicate: boolean;
  h1Count: number;
  bytes: number;
  weightOutlier: boolean;
  /** Hops before the final URL; two or more is a redirect chain. */
  redirects: string[];
  /** Broken same-site links found ON this page. */
  brokenLinksOut: number;
  deep?: CrawlPage["deep"];
}

export interface StructureAnalysis {
  checks: AuditCheck[];
  flags: string[];
  rows: StructureRow[];
  /** Pages listed in the sitemap that nothing in the crawl links to. */
  orphans: string[];
}

/**
 * A page is a weight outlier when it is both twice the median AND over 300 KB.
 * The median alone flags a tiny site where one page happens to carry a little
 * more markup, which is not a finding.
 *
 * These are HTML bytes only — the crawl fetches documents, not subresources.
 * The homepage's full transfer weight is measured separately by the probe.
 */
const OUTLIER_FACTOR = 2;
const OUTLIER_FLOOR_BYTES = 300_000;

/** Below this many pages, cross-page comparisons say nothing. */
const MIN_PAGES_FOR_COMPARISON = 2;

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function normalizeText(v: string | null): string | null {
  const t = (v ?? "").trim().toLowerCase();
  return t.length === 0 ? null : t;
}

/** Same page, ignoring the trailing slash and the scheme's www. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** Values appearing on more than one page, as a lookup. */
function duplicatesOf(values: Array<string | null>): Set<string> {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([v]) => v));
}

/**
 * Pages the sitemap advertises that no crawled page links to.
 *
 * An "orphan hint", not a verdict: we only visited a capped slice of the site,
 * so a page could be linked from somewhere we never opened. The label says
 * hint, and the check is skipped entirely when the crawl was truncated.
 */
export function orphanHints(crawl: CrawlResult): string[] {
  if (crawl.sitemapUrls.length === 0) return [];
  // Only inbound links count. Having VISITED a page proves nothing: the
  // crawler opens sitemap entries directly, so treating a reached page as
  // linked would make the orphan check unable to ever fire — which is exactly
  // what it did until a fixture site with an unlinked page showed it.
  const linked = new Set<string>();
  for (const page of crawl.pages) {
    for (const link of page.links) linked.add(canonical(link));
  }
  const start = canonical(crawl.startUrl);
  return crawl.sitemapUrls.filter((u) => {
    const c = canonical(u);
    return c !== start && !linked.has(c);
  });
}

export function analyzeStructure(crawl: CrawlResult): StructureAnalysis {
  const pages = crawl.pages;
  const reachable = pages.filter((p) => p.status !== null && p.status < 400);

  const titles = reachable.map((p) => normalizeText(p.title));
  const metas = reachable.map((p) => normalizeText(p.metaDescription));
  const dupTitles = duplicatesOf(titles);
  const dupMetas = duplicatesOf(metas);

  const weights = reachable.map((p) => p.bytes).filter((b) => b > 0);
  const medianBytes = median(weights);
  const outlierThreshold = Math.max(medianBytes * OUTLIER_FACTOR, OUTLIER_FLOOR_BYTES);

  const brokenByPage = new Map<string, number>();
  for (const b of crawl.brokenLinks) {
    brokenByPage.set(b.from, (brokenByPage.get(b.from) ?? 0) + 1);
  }

  const rows: StructureRow[] = pages.map((p) => {
    const t = normalizeText(p.title);
    const m = normalizeText(p.metaDescription);
    const ok = p.status !== null && p.status < 400;
    return {
      url: p.url,
      path: pathOf(p.url),
      status: p.status,
      title: p.title,
      titleDuplicate: !!t && dupTitles.has(t),
      metaDescription: p.metaDescription,
      metaDuplicate: !!m && dupMetas.has(m),
      h1Count: p.h1Count,
      bytes: p.bytes,
      weightOutlier: ok && p.bytes > outlierThreshold && weights.length >= 3,
      redirects: p.redirects,
      brokenLinksOut: brokenByPage.get(p.url) ?? 0,
      ...(p.deep ? { deep: p.deep } : {}),
    };
  });

  const checks: AuditCheck[] = [];
  const add = (key: string, label: string, pass: boolean, detail?: string) =>
    checks.push({ key, label, pass, ...(detail ? { detail } : {}) });

  // Broken links stand on their own: one crawled page is enough to find one.
  add(
    "brokenLinks",
    "No broken internal links",
    crawl.brokenLinks.length === 0,
    crawl.brokenLinks.length > 0
      ? `${crawl.brokenLinks.length} broken${crawl.linkCheckTruncated ? " (partial check)" : ""}`
      : undefined,
  );

  const chains = pages.filter((p) => p.redirects.length >= 2);
  add(
    "redirectChains",
    "No redirect chains",
    chains.length === 0,
    chains.length > 0 ? `${chains.length} pages` : undefined,
  );

  // Everything below compares pages against each other, so it needs pages.
  if (reachable.length >= MIN_PAGES_FOR_COMPARISON) {
    const missingTitles = titles.filter((t) => t === null).length;
    add(
      "pageTitles",
      "Every page has a title",
      missingTitles === 0,
      missingTitles > 0 ? `${missingTitles} missing` : undefined,
    );
    add(
      "duplicateTitles",
      "Page titles are unique",
      dupTitles.size === 0,
      dupTitles.size > 0 ? `${dupTitles.size} repeated` : undefined,
    );

    const missingMetas = metas.filter((m) => m === null).length;
    add(
      "pageMetaDescriptions",
      "Every page has a meta description",
      missingMetas === 0,
      missingMetas > 0 ? `${missingMetas} missing` : undefined,
    );
    add(
      "duplicateMetaDescriptions",
      "Meta descriptions are unique",
      dupMetas.size === 0,
      dupMetas.size > 0 ? `${dupMetas.size} repeated` : undefined,
    );

    const badH1 = reachable.filter((p) => p.h1Count !== 1).length;
    add(
      "h1Consistency",
      "One H1 per page",
      badH1 === 0,
      badH1 > 0 ? `${badH1} pages` : undefined,
    );

    const outliers = rows.filter((r) => r.weightOutlier);
    if (weights.length >= 3) {
      add(
        "pageWeightOutliers",
        "No unusually heavy pages (HTML)",
        outliers.length === 0,
        outliers.length > 0
          ? `${outliers.length} over ${Math.round(outlierThreshold / 1000)} KB`
          : undefined,
      );
    }
  }

  // An orphan hint is only honest on a crawl that finished: a truncated one
  // simply did not open the page that links there.
  const orphans = crawl.deadlineHit || crawl.discovered > crawl.cap ? [] : orphanHints(crawl);
  if (crawl.sitemapUrls.length > 0 && !crawl.deadlineHit && crawl.discovered <= crawl.cap) {
    add(
      "orphanPages",
      "Sitemap pages are linked",
      orphans.length === 0,
      orphans.length > 0 ? `${orphans.length} unlinked` : undefined,
    );
  }

  const flags: string[] = [];
  if (crawl.brokenLinks.length > 0) flags.push("broken links");
  if (dupTitles.size > 0) flags.push("duplicate titles");

  return { checks, flags, rows, orphans };
}
