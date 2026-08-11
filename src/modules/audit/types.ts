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
