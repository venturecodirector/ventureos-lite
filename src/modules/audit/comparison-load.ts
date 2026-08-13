/**
 * Loading a stored comparison outside a user session (P2/3).
 *
 * The server action version resolves the workspace from the session. Two
 * callers cannot: the PDF worker (no session at all) and the public share page
 * (a deliberate cross-tenant read keyed on an unguessable slug). Both need the
 * same table, so the query lives here once and takes whichever client the
 * caller already holds.
 */
import { buildComparison, comparisonAuditIds, type ComparisonTable } from "./comparison";
import type { AuditCheck } from "./types";

interface AuditRowLike {
  id: string;
  url: string;
  status: string;
  score: number;
  checks: unknown;
  company?: { name: string } | null;
}

interface MinimalClient {
  auditResult: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: {
        id: true;
        url: true;
        status: true;
        score: true;
        checks: true;
        company: { select: { name: true } };
      };
    }): Promise<AuditRowLike[]>;
  };
}

function toSubject(row: AuditRowLike) {
  return {
    auditId: row.id,
    url: row.url,
    name: row.company?.name ?? null,
    score: row.score,
    checks: Array.isArray(row.checks) ? (row.checks as unknown as AuditCheck[]) : [],
  };
}

export async function loadComparison(
  db: MinimalClient,
  primary: AuditRowLike & { comparison: unknown },
): Promise<ComparisonTable | null> {
  const ids = comparisonAuditIds(primary.comparison);
  if (ids.length === 0) return null;

  const rows = await db.auditResult.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      url: true,
      status: true,
      score: true,
      checks: true,
      company: { select: { name: true } },
    },
  });

  // An unfinished audit scores 0, which would read as a flawless competitor.
  // Only completed ones enter the table.
  const done = ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is AuditRowLike => !!r && r.status === "done");
  if (done.length === 0) return null;

  return buildComparison([toSubject(primary), ...done.map(toSubject)]);
}
