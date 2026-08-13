import type { AuditVerdict } from "@prisma/client";
import type { CruxData } from "./crux";

/**
 * Normalized site probe (produced by the worker's Playwright/fetch/PSI stage).
 * The analysis functions are pure over this shape, so scoring/flags/verdict are
 * fully testable without a browser or network.
 */
export interface PsiScores {
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
}

export interface PageProbe {
  url: string;
  finalUrl: string;
  isHttps: boolean;
  statusOk: boolean;
  hasViewport: boolean;
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  imgTotal: number;
  imgWithAlt: number;
  hasSitemap: boolean;
  hasRobots: boolean;
  copyrightYear: number | null;
  hasPhone: boolean;
  hasEmail: boolean;
  hasForm: boolean;
  hasBooking: boolean;
  hasCookieBanner: boolean;
  pageWeightBytes: number;
  psi: PsiScores | null;
  screenshots: { desktop?: string; mobile?: string };

  // ---- P1/3c: expanded deterministic signals -----------------------------
  // Every one is OPTIONAL on purpose. `undefined` means "not measured" — the
  // analysis then emits no check for it, and its category reports null rather
  // than counting a failure we never actually observed (a DNS timeout is not
  // a missing SPF record).
  httpsRedirect?: boolean;
  /** Days until the certificate expires; negative when already expired. */
  sslDaysLeft?: number | null;
  hsts?: boolean;
  xContentTypeOptions?: boolean;
  xFrameOptions?: boolean;
  csp?: boolean;
  /** http:// subresources on an https page. */
  mixedContent?: boolean;

  spf?: boolean;
  dmarc?: boolean;

  hasImpresszum?: boolean;
  hasPrivacyPolicy?: boolean;
  hasAszf?: boolean;
  /** Drives whether ÁSZF is even applicable. */
  isWebshop?: boolean;

  hasOpenGraph?: boolean;
  hasCanonical?: boolean;
  hasSchemaOrg?: boolean;
  /** Exactly one h1 and no skipped levels. */
  headingHierarchyOk?: boolean;
  sitemapUrlCount?: number | null;

  hasAnalytics?: boolean;

  /** axe-core violation counts by impact. */
  a11y?: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    /** Plain-language descriptions of the worst three. */
    top: string[];
  } | null;
}

/**
 * What a deep probe adds for a page we did not make the homepage (P2/1).
 *
 * The crawl visits up to 25 pages with plain fetches; running Playwright and
 * axe on every one of them would cost minutes. Only the homepage and the two
 * heaviest pages get this, and it is evidence for the per-page detail rows —
 * it deliberately does not feed the opportunity score (see analyzeStructure).
 */
export interface DeepPageProbe {
  mixedContent?: boolean;
  headingHierarchyOk?: boolean;
  a11y?: PageProbe["a11y"];
}

/** One page as the crawler found it. */
export interface CrawlPage {
  /** The URL we requested. */
  url: string;
  /** Where we ended up, after any redirects. */
  finalUrl: string;
  /** null when the request itself failed (DNS, timeout, connection reset). */
  status: number | null;
  /** Intermediate hops, excluding the final URL. Two or more is a chain. */
  redirects: string[];
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  bytes: number;
  /** Same-site absolute URLs linked from this page. */
  links: string[];
  deep?: DeepPageProbe;
}

export interface BrokenLink {
  from: string;
  to: string;
  /** null when the request failed outright rather than answering 4xx/5xx. */
  status: number | null;
}

/** The whole crawl, as stored on the audit row and rendered in the report. */
export interface CrawlResult {
  startUrl: string;
  pages: CrawlPage[];
  brokenLinks: BrokenLink[];
  /** URLs listed in sitemap.xml, used for the orphan check. */
  sitemapUrls: string[];
  /** How many pages we were allowed to visit. */
  cap: number;
  /** Same-site URLs we found in total, visited or not. */
  discovered: number;
  /** Skipped because robots.txt disallowed them. */
  robotsSkipped: number;
  /** True when there were more links to verify than the link-check budget. */
  linkCheckTruncated: boolean;
  /** True when the crawl stopped on its deadline rather than running out of pages. */
  deadlineHit: boolean;
  elapsedMs: number;
}

export interface AuditCheck {
  key: string;
  label: string;
  pass: boolean;
  detail?: string;
}

export interface AuditAnalysis {
  score: number; // 0–100 opportunity score (high = weak site = strong prospect)
  verdict: AuditVerdict; // STRONG | POSSIBLE | SKIP
  checks: AuditCheck[];
  flags: string[]; // human trigger-signal labels, attach to the lead
}

/** Client-facing audit record (what the UI polls for progressive results). */
export interface AuditView {
  id: string;
  url: string;
  status: string; // queued | running | done | error
  score: number;
  verdict: AuditVerdict;
  checks: AuditCheck[];
  flags: string[];
  screenshots: { desktop?: string; mobile?: string };
  pitchSummary: string | null;
  pdfPath: string | null;
  /** Present only for an internal crawl run; null on single-page audits. */
  crawl: CrawlResult | null;
  /** Chrome UX field data; null when the origin has too little traffic. */
  crux: CruxData | null;
}
