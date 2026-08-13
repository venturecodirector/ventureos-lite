import type { AuditVerdict } from "@prisma/client";
import type { AuditView, AuditCheck, CrawlResult } from "./types";
import type { CruxData } from "./crux";
import type { AuditDelta } from "./delta";

/**
 * Pure mapper AuditResult row -> AuditView, shared by the web action (getAudit),
 * the PDF job, and the public share page.
 */
interface AuditRowLike {
  id: string;
  url: string;
  status: string;
  score: number;
  verdict: AuditVerdict;
  checks: unknown;
  flags: unknown;
  screenshots: unknown;
  pitchSummary: string | null;
  pdfPath: string | null;
  /** Optional so a caller that selected a narrow column set still type-checks. */
  crawl?: unknown;
  crux?: unknown;
  delta?: unknown;
}

export function auditRowToView(a: AuditRowLike): AuditView {
  return {
    id: a.id,
    url: a.url,
    status: a.status,
    score: a.score,
    verdict: a.verdict,
    checks: Array.isArray(a.checks) ? (a.checks as unknown as AuditCheck[]) : [],
    flags: Array.isArray(a.flags) ? (a.flags as string[]) : [],
    screenshots:
      a.screenshots && typeof a.screenshots === "object" && !Array.isArray(a.screenshots)
        ? (a.screenshots as { desktop?: string; mobile?: string })
        : {},
    pitchSummary: a.pitchSummary ?? null,
    pdfPath: a.pdfPath ?? null,
    // A crawl is an object with a pages array; anything else (including the
    // JSON null Prisma stores) is "this audit was single-page".
    crawl:
      a.crawl && typeof a.crawl === "object" && Array.isArray((a.crawl as CrawlResult).pages)
        ? (a.crawl as CrawlResult)
        : null,
    crux:
      a.crux && typeof a.crux === "object" && !Array.isArray(a.crux)
        ? (a.crux as CruxData)
        : null,
    delta:
      a.delta && typeof a.delta === "object" && !Array.isArray(a.delta)
        ? (a.delta as AuditDelta)
        : null,
  };
}
