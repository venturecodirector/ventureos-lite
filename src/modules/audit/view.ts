import type { AuditVerdict } from "@prisma/client";
import type { AuditView, AuditCheck } from "./types";

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
  };
}
