import type { AuditVerdict } from "@prisma/client";
import {
  DEFAULT_AUDIT_THRESHOLDS,
  type AuditThresholds,
} from "./config";
import type { AuditAnalysis, AuditCheck, PageProbe } from "./types";

/**
 * Rule-based opportunity scoring (spec §4.4). High score = weak site = strong
 * sales opportunity. No AI here — thresholds come from Settings; the verdict is
 * a rule, not a model.
 */

function fmtMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function verdictFor(
  score: number,
  thresholds: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS,
): AuditVerdict {
  if (score >= thresholds.verdict.strong) return "STRONG";
  if (score >= thresholds.verdict.possible) return "POSSIBLE";
  return "SKIP";
}

export function analyzeAudit(
  probe: PageProbe,
  thresholds: AuditThresholds = DEFAULT_AUDIT_THRESHOLDS,
  now: Date = new Date(),
): AuditAnalysis {
  const altCoverage =
    probe.imgTotal === 0 ? 1 : probe.imgWithAlt / probe.imgTotal;
  const copyrightOld =
    probe.copyrightYear !== null && probe.copyrightYear < now.getUTCFullYear() - 2;
  const hasContact = probe.hasPhone || probe.hasEmail || probe.hasForm;

  const checks: AuditCheck[] = [
    { key: "https", label: "HTTPS valid", pass: probe.isHttps },
    { key: "viewport", label: "Mobile viewport", pass: probe.hasViewport },
    { key: "title", label: "Page title", pass: !!probe.title },
    { key: "metaDescription", label: "Meta description", pass: !!probe.metaDescription },
    { key: "h1", label: "H1 heading", pass: probe.h1Count >= 1 },
    {
      key: "altCoverage",
      label: "Image alt coverage",
      pass: altCoverage >= 0.5,
      detail: `${Math.round(altCoverage * 100)}%`,
    },
    { key: "sitemap", label: "sitemap.xml", pass: probe.hasSitemap },
    { key: "robots", label: "robots.txt", pass: probe.hasRobots },
    {
      key: "copyright",
      label: "Copyright year",
      pass: !copyrightOld,
      detail: probe.copyrightYear ? String(probe.copyrightYear) : undefined,
    },
    { key: "contact", label: "Contact method visible", pass: hasContact },
    { key: "booking", label: "Online booking", pass: probe.hasBooking },
    { key: "cookie", label: "Cookie consent (GDPR)", pass: probe.hasCookieBanner },
    {
      key: "pageWeight",
      label: "Page weight",
      pass: probe.pageWeightBytes <= thresholds.heavyPageBytes,
      detail: fmtMb(probe.pageWeightBytes),
    },
  ];

  if (probe.psi) {
    checks.push(
      {
        key: "psiPerformance",
        label: "PageSpeed performance",
        pass: (probe.psi.performance ?? 100) >= 50,
        detail: probe.psi.performance != null ? `${probe.psi.performance}/100` : undefined,
      },
      {
        key: "psiSeo",
        label: "PageSpeed SEO",
        pass: (probe.psi.seo ?? 100) >= 50,
        detail: probe.psi.seo != null ? `${probe.psi.seo}/100` : undefined,
      },
      {
        key: "psiAccessibility",
        label: "PageSpeed accessibility",
        pass: (probe.psi.accessibility ?? 100) >= 50,
        detail:
          probe.psi.accessibility != null ? `${probe.psi.accessibility}/100` : undefined,
      },
    );
  }

  // Deterministic check weights (PSI is scored separately via a penalty).
  let score = 0;
  for (const c of checks) {
    if (!c.pass) score += thresholds.weights[c.key] ?? 0;
  }
  if (probe.psi?.performance != null) {
    score += ((100 - probe.psi.performance) / 100) * thresholds.psiPenaltyMax;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Opportunity flags — attach to the lead as trigger signals (spec §4.4).
  const flags: string[] = [];
  if (!probe.hasViewport) flags.push("no mobile");
  if (probe.psi?.performance != null && probe.psi.performance < 50) flags.push("slow site");
  if (copyrightOld) flags.push("outdated website");
  if (!hasContact) flags.push("no conversion path");
  if (!probe.hasBooking) flags.push("no online booking");
  if (!probe.hasCookieBanner) flags.push("GDPR gap");
  if (!probe.metaDescription) flags.push("weak SEO");

  return { score, verdict: verdictFor(score, thresholds), checks, flags };
}
