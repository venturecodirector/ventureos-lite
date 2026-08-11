/**
 * Audit scoring config — verdict thresholds and check weights, admin-configurable
 * from Settings (spec §4.4: "thresholds set in Settings, not by AI"). Stored on
 * Workspace.auditConfig; falls back to these defaults.
 */
export interface AuditThresholds {
  verdict: { strong: number; possible: number };
  weights: Record<string, number>;
  heavyPageBytes: number;
  psiPenaltyMax: number;
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  verdict: { strong: 70, possible: 40 },
  weights: {
    https: 10,
    viewport: 15,
    title: 4,
    metaDescription: 8,
    h1: 6,
    altCoverage: 6,
    sitemap: 4,
    robots: 3,
    copyright: 8,
    contact: 8,
    booking: 6,
    cookie: 5,
    pageWeight: 8,
  },
  heavyPageBytes: 3_000_000,
  psiPenaltyMax: 20,
};

export function auditThresholdsFromConfig(cfg: unknown): AuditThresholds {
  if (!cfg || typeof cfg !== "object") return DEFAULT_AUDIT_THRESHOLDS;
  const c = cfg as Partial<AuditThresholds>;
  return {
    verdict: { ...DEFAULT_AUDIT_THRESHOLDS.verdict, ...c.verdict },
    weights: { ...DEFAULT_AUDIT_THRESHOLDS.weights, ...c.weights },
    heavyPageBytes: c.heavyPageBytes ?? DEFAULT_AUDIT_THRESHOLDS.heavyPageBytes,
    psiPenaltyMax: c.psiPenaltyMax ?? DEFAULT_AUDIT_THRESHOLDS.psiPenaltyMax,
  };
}
