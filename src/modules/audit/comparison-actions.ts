"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { getPlacesClient } from "@/lib/places";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { TEXT_SEARCH_COST_USD } from "@/modules/prospector/cost";
import { recordApiUsage } from "@/lib/api-usage";
import { normalizeDomain } from "../leads/dedupe";
import { enqueueAudit } from "./enqueue";
import {
  buildComparison,
  comparisonAuditIds,
  type ComparisonSubject,
  type ComparisonTable,
} from "./comparison";
import type { AuditCheck } from "./types";

/**
 * Running a competitor comparison (P2/3).
 *
 * Competitor audits are ORDINARY audits: same worker, same 30-day cache, same
 * table. That is what makes the feature nearly free on the second run and what
 * lets a competitor become a lead later without a migration — it is already a
 * company with an audit attached, merely marked as to how it arrived.
 *
 * Never crawled: a comparison needs the same single-page check set on both
 * sides, and spending 45s of crawl on someone we are not selling to would be
 * paying for a page of the report nobody reads.
 */
const MAX_COMPETITORS = 2;
const CACHE_TTL_MS = 30 * 86_400_000;

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export interface CompetitorCandidate {
  name: string;
  url: string;
  category: string | null;
  address: string | null;
}

export interface CompetitorSuggestions {
  candidates: CompetitorCandidate[];
  /** Shown BEFORE the search runs, like every other Places call. */
  costUsd: number;
  /** Why there are no candidates, when there are none. */
  unavailable: "no_company" | "no_category" | "no_key" | "none_found" | null;
}


/**
 * Nearby businesses in the same category, with a website of their own.
 *
 * Same category and same city is what makes them a comparison a business owner
 * accepts. Anything without a website is skipped: there is nothing to audit,
 * and "they have no site at all" is not a comparison the prospect learns from.
 */
export async function suggestCompetitors(auditId: string): Promise<CompetitorSuggestions> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const audit = await db.auditResult.findUnique({
    where: { id: auditId },
    select: { url: true, company: { select: { industry: true, city: true, address: true } } },
  });
  if (!audit) throw new Error("Audit not found");

  const company = audit.company;
  if (!company) return { candidates: [], costUsd: 0, unavailable: "no_company" };
  const keyword = company.industry?.trim();
  const location = company.city?.trim() || company.address?.trim();
  if (!keyword || !location) {
    return { candidates: [], costUsd: 0, unavailable: "no_category" };
  }

  const key = await resolveIntegration(workspaceId, "google.placesApiKey");
  if (!key) return { candidates: [], costUsd: 0, unavailable: "no_key" };

  const ownDomain = normalizeDomain(audit.url);
  const res = await getPlacesClient(key).textSearch({ keyword, location });
  await recordApiUsage({
    workspaceId,
    provider: "places",
    operation: "competitor.search",
    calls: res.requestCount,
    costUsd: res.requestCount * TEXT_SEARCH_COST_USD,
  });

  const seen = new Set<string>();
  const candidates: CompetitorCandidate[] = [];
  for (const r of res.results) {
    if (!r.websiteUri) continue;
    const domain = normalizeDomain(r.websiteUri);
    if (!domain || domain === ownDomain || seen.has(domain)) continue;
    seen.add(domain);
    candidates.push({
      name: r.name,
      url: r.websiteUri,
      category: r.category,
      address: r.address,
    });
    if (candidates.length >= 6) break; // a shortlist to pick two from
  }

  return {
    candidates,
    costUsd: res.requestCount * TEXT_SEARCH_COST_USD,
    unavailable: candidates.length === 0 ? "none_found" : null,
  };
}

const runSchema = z.object({
  auditId: z.string().min(1),
  urls: z.array(z.string().min(1)).min(1).max(MAX_COMPETITORS),
});

/**
 * Audit each competitor (reusing any fresh cached run) and attach the ids to
 * the prospect's audit.
 *
 * Returns as soon as the jobs are queued; the UI polls, exactly as it does for
 * the primary audit.
 */
export async function runComparison(raw: unknown): Promise<{ auditIds: string[] }> {
  const input = runSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const primary = await db.auditResult.findUnique({
    where: { id: input.auditId },
    select: { id: true, url: true },
  });
  if (!primary) throw new Error("Audit not found");

  const auditIds: string[] = [];
  for (const raw of input.urls) {
    const url = normalizeUrl(raw);
    if (normalizeDomain(url) === normalizeDomain(primary.url)) continue;

    const cached = await db.auditResult.findFirst({
      where: { url, status: "done", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (cached) {
      auditIds.push(cached.id);
      continue;
    }

    // The competitor becomes a company in its own right — deduped against
    // whatever is already here, because it may well BE an existing prospect.
    const domain = normalizeDomain(url);
    let companyId: string | undefined;
    if (domain) {
      const existing = await db.company.findFirst({
        where: { OR: [{ domain }, { website: { contains: domain } }] },
        select: { id: true },
      });
      companyId =
        existing?.id ??
        (
          await db.company.create({
            data: {
              workspaceId,
              name: domain,
              domain,
              website: url,
              source: "competitor_audit",
            },
          })
        ).id;
    }

    const rec = await db.auditResult.create({
      data: {
        workspaceId,
        companyId,
        url,
        status: "queued",
        score: 0,
        verdict: "SKIP",
        flags: [],
        screenshots: {},
        expiresAt: new Date(Date.now() + CACHE_TTL_MS),
      },
    });
    // No pitch and no crawl: this audit exists to fill five table cells.
    await enqueueAudit({ auditId: rec.id, workspaceId, url, withPitch: false });
    auditIds.push(rec.id);
  }

  await db.auditResult.update({
    where: { id: input.auditId },
    data: { comparison: { auditIds } },
  });
  revalidatePath("/audit");
  return { auditIds };
}

export async function clearComparison(auditId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  // Prisma.DbNull, not null: for a nullable Json column, plain null means "do
  // not touch this field".
  await db.auditResult.update({
    where: { id: auditId },
    data: { comparison: Prisma.DbNull },
  });
  revalidatePath("/audit");
  return { ok: true };
}

interface AuditRowForComparison {
  id: string;
  url: string;
  status: string;
  score: number;
  checks: unknown;
  company: { name: string } | null;
}

function toSubject(row: AuditRowForComparison): ComparisonSubject {
  return {
    auditId: row.id,
    url: row.url,
    name: row.company?.name ?? null,
    score: row.score,
    checks: Array.isArray(row.checks) ? (row.checks as unknown as AuditCheck[]) : [],
  };
}

/**
 * The built table for an audit, or null when no comparison was run.
 *
 * Competitor audits that are still running are left out rather than shown as
 * zeroes — an unfinished audit scores 0, which would read as a perfect site.
 */
export async function getComparison(auditId: string): Promise<ComparisonTable | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const primary = await db.auditResult.findUnique({
    where: { id: auditId },
    select: {
      id: true,
      url: true,
      status: true,
      score: true,
      checks: true,
      comparison: true,
      company: { select: { name: true } },
    },
  });
  if (!primary) return null;

  const ids = comparisonAuditIds(primary.comparison);
  if (ids.length === 0) return null;

  const competitors = await db.auditResult.findMany({
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

  const done = competitors.filter((c) => c.status === "done");
  if (done.length === 0) return null;

  // Keep the order the operator picked.
  const ordered = ids
    .map((id) => done.find((c) => c.id === id))
    .filter((c): c is (typeof done)[number] => !!c);

  return buildComparison([toSubject(primary), ...ordered.map(toSubject)]);
}

export interface ComparisonProgress {
  /** Competitor audits still queued or running. */
  pending: number;
  /**
   * Competitor audits that failed, with the reason.
   *
   * These used to vanish. `getComparison` keeps only `status === "done"` rows,
   * and this function counted only queued/running ones — so a competitor whose
   * audit failed left the polling loop immediately AND was dropped from the
   * table, and the operator who picked two competitors got one column back
   * with nothing anywhere saying what happened to the other. If all of them
   * failed, the panel rendered nothing at all.
   */
  failed: Array<{ url: string; message: string | null }>;
}

/** How the competitor audits are getting on, for the polling UI. */
export async function comparisonProgress(auditId: string): Promise<ComparisonProgress> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const row = await db.auditResult.findUnique({
    where: { id: auditId },
    select: { comparison: true },
  });
  const ids = comparisonAuditIds(row?.comparison);
  if (ids.length === 0) return { pending: 0, failed: [] };

  const rows = await db.auditResult.findMany({
    where: { id: { in: ids } },
    select: { url: true, status: true, errorMessage: true },
  });
  return {
    pending: rows.filter((r) => r.status === "queued" || r.status === "running").length,
    failed: rows
      .filter((r) => r.status === "error")
      .map((r) => ({ url: r.url, message: r.errorMessage })),
  };
}
