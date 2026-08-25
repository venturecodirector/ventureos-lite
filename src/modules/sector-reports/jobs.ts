import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getPlacesClient } from "@/lib/places";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { TEXT_SEARCH_COST_USD } from "@/modules/prospector/cost";
import { enqueueAudit } from "@/modules/audit/enqueue";
import { normalizeDomain } from "@/modules/leads/domain";
import { isDirectoryDomain } from "@/modules/leads/domain";
import { collectAuditInputs, aggregateFor } from "./collect";
import { MIN_PUBLISHABLE } from "./stats";

/**
 * Running one sector batch (playbook-v4 P12/2a).
 *
 * ── BOUNDED ON PURPOSE, IN THREE PLACES ────────────────────────────────────
 *
 * The cap the Owner set, Google's own 60-result ceiling, and the reuse of any
 * audit less than 30 days old. A batch that re-measures a site somebody audited
 * last week spends money to learn nothing, and a batch with no ceiling is a
 * crawl with a friendly name.
 *
 * Every audit lands in the ordinary AuditResult store — deliberately, because
 * this is also the data-collection engine for the P15 digital index.
 */
const REUSE_MS = 30 * 24 * 60 * 60 * 1000;

export async function processSectorBatch(reportId: string): Promise<number> {
  const report = await prismaUnsafe.sectorReport.findUnique({ where: { id: reportId } });
  if (!report || report.status !== "running") return 0;

  const db = getWorkspaceClient(report.workspaceId);
  const placesKey = await resolveIntegration(report.workspaceId, "google.placesApiKey");

  let found = 0;
  let costUsd = 0;
  const auditIds: string[] = [];

  try {
    const search = await getPlacesClient(placesKey).textSearch({
      keyword: report.sector,
      location: report.location,
      maxResults: Math.min(60, report.cap),
    });
    found = search.results.length;
    costUsd = search.requestCount * TEXT_SEARCH_COST_USD;

    for (const place of search.results) {
      if (auditIds.length >= report.cap) break;
      const domain = normalizeDomain(place.websiteUri);
      // A directory listing is not this business's website.
      if (!domain || isDirectoryDomain(domain)) continue;
      const url = `https://${domain}`;

      const recent = await db.auditResult.findFirst({
        where: {
          url,
          status: { in: ["queued", "running", "done"] },
          createdAt: { gte: new Date(Date.now() - REUSE_MS) },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (recent) {
        auditIds.push(recent.id);
        continue;
      }

      const created = await db.auditResult.create({
        data: {
          workspaceId: report.workspaceId,
          url,
          status: "queued",
          score: 0,
          verdict: "SKIP",
          flags: [],
          screenshots: {},
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
        select: { id: true },
      });
      auditIds.push(created.id);
      // No pitch summary: that is a Claude call per site, and a batch of sixty
      // would be sixty calls for prose no report ever prints.
      await enqueueAudit({
        auditId: created.id,
        workspaceId: report.workspaceId,
        url,
        withPitch: false,
      });
    }
  } catch (e) {
    await prismaUnsafe.sectorReport.update({
      where: { id: reportId },
      data: { status: "draft" },
    });
    // eslint-disable-next-line no-console
    console.error(`[sector] batch ${reportId} failed to start`, e);
    return 0;
  }

  await prismaUnsafe.sectorReport.update({
    where: { id: reportId },
    data: { foundCount: found, costUsd, stats: { auditIds } as unknown as object },
  });
  return auditIds.length;
}

/**
 * Turn a finished batch into aggregates.
 *
 * Separate from the batch because the audits run asynchronously: this is the
 * sweep that notices when enough of them have landed and computes the numbers.
 * It refuses to produce a report below the publishable sample — a "median" from
 * four businesses is one business wearing a statistic's clothes.
 */
export async function processSectorAggregation(): Promise<number> {
  const running = await prismaUnsafe.sectorReport.findMany({
    where: { status: "running" },
    select: { id: true, workspaceId: true, stats: true, foundCount: true },
  });
  let finished = 0;

  for (const report of running) {
    const ids = ((report.stats ?? {}) as { auditIds?: string[] }).auditIds ?? [];
    if (ids.length === 0) continue;

    const db = getWorkspaceClient(report.workspaceId);
    const pending = await db.auditResult.count({
      where: { id: { in: ids }, status: { in: ["queued", "running"] } },
    });
    if (pending > 0) continue;

    const inputs = await collectAuditInputs(db, ids);
    if (inputs.length < MIN_PUBLISHABLE) {
      await prismaUnsafe.sectorReport.update({
        where: { id: report.id },
        data: {
          status: "draft",
          auditedCount: inputs.length,
          stats: {
            auditIds: ids,
            tooSmall: true,
            note: `Csak ${inputs.length} oldalt sikerült megmérni — ${MIN_PUBLISHABLE} az alsó határ.`,
          } as unknown as object,
        },
      });
      continue;
    }

    const stats = aggregateFor(inputs, report.foundCount);
    await prismaUnsafe.sectorReport.update({
      where: { id: report.id },
      data: {
        status: "ready",
        auditedCount: inputs.length,
        stats: { ...stats, auditIds: ids } as unknown as object,
      },
    });
    finished += 1;
  }
  return finished;
}
