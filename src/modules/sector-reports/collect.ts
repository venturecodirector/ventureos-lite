import type { WorkspaceClient } from "@/lib/db";
import { scoreByCategory } from "@/modules/audit/categories";
import type { AuditCheck } from "@/modules/audit/types";
import type { CruxData } from "@/modules/audit/crux";
import { aggregate, type AuditInput, type SectorStats } from "./stats";

/**
 * Read a batch of finished audits into the shape the aggregator wants
 * (playbook-v4 P12/2a).
 *
 * The seam matters: this is the ONLY place a stored audit becomes report
 * material, and it deliberately drops everything that could name a business —
 * the url, the company id, the screenshots. What comes out the other side has
 * nowhere to put a name.
 */
export async function collectAuditInputs(
  db: WorkspaceClient,
  auditIds: string[],
): Promise<AuditInput[]> {
  if (auditIds.length === 0) return [];
  const rows = await db.auditResult.findMany({
    where: { id: { in: auditIds }, status: "done" },
    // Note what is NOT selected: url, companyId, screenshots, pitchSummary.
    select: { score: true, checks: true, crux: true },
  });

  return rows.map((r) => {
    const checks = Array.isArray(r.checks) ? (r.checks as unknown as AuditCheck[]) : [];
    const byKey: Record<string, boolean | null> = {};
    for (const c of checks) byKey[c.key] = typeof c.pass === "boolean" ? c.pass : null;

    const categories: AuditInput["categories"] = {};
    for (const s of scoreByCategory(checks)) categories[s.category] = s.subscore;

    const crux = (r.crux ?? null) as CruxData | null;
    return {
      score: r.score,
      categories,
      checks: byKey,
      loadMs: crux?.lcp?.p75 ?? null,
    };
  });
}

export function aggregateFor(inputs: AuditInput[], found: number): SectorStats {
  return aggregate(inputs, found);
}
