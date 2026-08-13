import type { AuditVerdict } from "@prisma/client";

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
}
