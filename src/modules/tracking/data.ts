import { getWorkspaceClient } from "@/lib/db";
import type { Confidence, PageType } from "./types";

/**
 * What the signal layer can tell a page's owner (playbook-v3 P8/c, P8/d).
 *
 * Every number here is a count of ROWS, and a row is a reading session — so
 * "12 megtekintés" means twelve times somebody opened it, not twelve heartbeats.
 */

export interface IdentifiedViewer {
  companyId: string | null;
  name: string;
  confidence: Confidence;
  views: number;
}

export interface PageStats {
  views: number;
  lastViewAt: Date | null;
  avgDurationMs: number;
  /** Named companies, best confidence first. */
  viewers: IdentifiedViewer[];
  unidentified: number;
  /** Set only for a page addressed to a specific company (P8/d). */
  recipientViewed: { viewed: boolean; times: number; confidence: Confidence } | null;
}

const EMPTY: PageStats = {
  views: 0,
  lastViewAt: null,
  avgDurationMs: 0,
  viewers: [],
  unidentified: 0,
  recipientViewed: null,
};

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1, none: 0 };

export async function pageStats(
  workspaceId: string,
  pageType: PageType,
  slug: string,
  /** The company the page was sent to, when it was sent to one. */
  targetCompanyId?: string | null,
): Promise<PageStats> {
  const db = getWorkspaceClient(workspaceId);
  const visits = await db.pageVisit.findMany({
    where: { pageType, pageSlug: slug },
    select: {
      startedAt: true,
      durationMs: true,
      guessCompanyId: true,
      orgName: true,
      confidence: true,
      doNotTrack: true,
    },
    orderBy: { startedAt: "desc" },
    take: 500,
  });
  if (visits.length === 0) return EMPTY;

  // Do-not-track visits count as views and contribute nothing else — they
  // carry no duration to average and no identity to name.
  const measured = visits.filter((v) => !v.doNotTrack);
  const totalMs = measured.reduce((sum, v) => sum + v.durationMs, 0);

  const named = new Map<string, IdentifiedViewer>();
  let unidentified = 0;
  let recipientTimes = 0;
  let recipientConfidence: Confidence = "none";

  const companyIds = [...new Set(visits.map((v) => v.guessCompanyId).filter(Boolean))] as string[];
  const companies = companyIds.length
    ? await db.company.findMany({
        where: { id: { in: companyIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(companies.map((c) => [c.id, c.name]));

  for (const v of visits) {
    const confidence = (v.confidence ?? "none") as Confidence;
    if (v.guessCompanyId) {
      const key = v.guessCompanyId;
      const row = named.get(key) ?? {
        companyId: key,
        name: nameById.get(key) ?? v.orgName ?? "ismeretlen cég",
        confidence,
        views: 0,
      };
      row.views += 1;
      // Keep the strongest evidence we ever had for this viewer.
      if (RANK[confidence] > RANK[row.confidence]) row.confidence = confidence;
      named.set(key, row);

      if (targetCompanyId && key === targetCompanyId) {
        recipientTimes += 1;
        if (RANK[confidence] > RANK[recipientConfidence]) recipientConfidence = confidence;
      }
    } else if (v.orgName && confidence === "low") {
      // An organisation we do not have as a company: still worth naming.
      const key = `org:${v.orgName}`;
      const row = named.get(key) ?? {
        companyId: null,
        name: v.orgName,
        confidence: "low" as Confidence,
        views: 0,
      };
      row.views += 1;
      named.set(key, row);
    } else {
      unidentified += 1;
    }
  }

  return {
    views: visits.length,
    lastViewAt: visits[0]?.startedAt ?? null,
    avgDurationMs: measured.length ? Math.round(totalMs / measured.length) : 0,
    viewers: [...named.values()].sort(
      (a, b) => RANK[b.confidence] - RANK[a.confidence] || b.views - a.views,
    ),
    unidentified,
    recipientViewed: targetCompanyId
      ? { viewed: recipientTimes > 0, times: recipientTimes, confidence: recipientConfidence }
      : null,
  };
}

export interface QuoteActivity {
  opens: number;
  sessions: number;
  lastOpenAt: Date | null;
  totalReadingMs: number;
  pricingMs: number;
  scopeMs: number;
  /** Share of sessions that reached the bottom of the page. */
  scrollToBottomPct: number;
  /** Sessions beyond the first from the same reader. */
  returnVisits: number;
  viewers: IdentifiedViewer[];
  unidentified: number;
}

/**
 * The "Ajánlat-aktivitás" panel (P8/c).
 *
 * The one number worth more than the rest is `pricingMs` against `scopeMs`: a
 * reader who spends three minutes on the price and never scrolls to the scope
 * is having a different conversation from one who does the opposite.
 */
export async function quoteActivity(
  workspaceId: string,
  acceptSlug: string,
): Promise<QuoteActivity> {
  const db = getWorkspaceClient(workspaceId);
  const visits = await db.pageVisit.findMany({
    where: { pageType: "quote", pageSlug: acceptSlug },
    select: {
      startedAt: true,
      durationMs: true,
      scrollPct: true,
      sections: true,
      sessionToken: true,
      guessCompanyId: true,
      orgName: true,
      confidence: true,
      doNotTrack: true,
    },
    orderBy: { startedAt: "desc" },
    take: 500,
  });

  let pricingMs = 0;
  let scopeMs = 0;
  let totalReadingMs = 0;
  let reachedBottom = 0;
  const seenTokens = new Map<string, number>();

  for (const v of visits) {
    totalReadingMs += v.durationMs;
    if (v.scrollPct >= 90) reachedBottom += 1;
    const sec = (v.sections ?? {}) as Record<string, number>;
    pricingMs += Number(sec.pricing ?? 0);
    scopeMs += Number(sec.scope ?? 0);
    seenTokens.set(v.sessionToken, (seenTokens.get(v.sessionToken) ?? 0) + 1);
  }

  const stats = await pageStats(workspaceId, "quote", acceptSlug);
  const returnVisits = [...seenTokens.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);

  return {
    opens: visits.length,
    sessions: seenTokens.size,
    lastOpenAt: visits[0]?.startedAt ?? null,
    totalReadingMs,
    pricingMs,
    scopeMs,
    scrollToBottomPct: visits.length ? Math.round((reachedBottom / visits.length) * 100) : 0,
    returnVisits,
    viewers: stats.viewers,
    unidentified: stats.unidentified,
  };
}

/**
 * Stats for many pages at once (P8/d).
 *
 * The Public Pages view lists a hundred shares and a hundred quotes; asking
 * `pageStats` per row would be two hundred round trips for one screen. One
 * query, bucketed in memory.
 */
export async function pageStatsBatch(
  workspaceId: string,
  slugs: string[],
): Promise<Map<string, PageStats>> {
  const out = new Map<string, PageStats>();
  if (slugs.length === 0) return out;

  const db = getWorkspaceClient(workspaceId);
  const visits = await db.pageVisit.findMany({
    where: { pageSlug: { in: slugs } },
    select: {
      pageSlug: true,
      startedAt: true,
      durationMs: true,
      guessCompanyId: true,
      orgName: true,
      confidence: true,
      doNotTrack: true,
    },
    orderBy: { startedAt: "desc" },
    take: 5000,
  });
  if (visits.length === 0) return out;

  const companyIds = [...new Set(visits.map((v) => v.guessCompanyId).filter(Boolean))] as string[];
  const companies = companyIds.length
    ? await db.company.findMany({
        where: { id: { in: companyIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(companies.map((c) => [c.id, c.name]));

  const buckets = new Map<
    string,
    { views: number; measured: number; totalMs: number; last: Date | null; named: Map<string, IdentifiedViewer>; unidentified: number }
  >();

  for (const v of visits) {
    let b = buckets.get(v.pageSlug);
    if (!b) {
      b = { views: 0, measured: 0, totalMs: 0, last: null, named: new Map(), unidentified: 0 };
      buckets.set(v.pageSlug, b);
    }
    b.views += 1;
    if (!b.last || v.startedAt > b.last) b.last = v.startedAt;
    if (!v.doNotTrack) {
      b.measured += 1;
      b.totalMs += v.durationMs;
    }

    const confidence = (v.confidence ?? "none") as Confidence;
    const key = v.guessCompanyId ?? (v.orgName ? `org:${v.orgName}` : null);
    if (!key) {
      b.unidentified += 1;
      continue;
    }
    const row = b.named.get(key) ?? {
      companyId: v.guessCompanyId,
      name: v.guessCompanyId
        ? (nameById.get(v.guessCompanyId) ?? v.orgName ?? "ismeretlen cég")
        : (v.orgName ?? "ismeretlen"),
      confidence,
      views: 0,
    };
    row.views += 1;
    if (RANK[confidence] > RANK[row.confidence]) row.confidence = confidence;
    b.named.set(key, row);
  }

  for (const [slug, b] of buckets) {
    out.set(slug, {
      views: b.views,
      lastViewAt: b.last,
      avgDurationMs: b.measured ? Math.round(b.totalMs / b.measured) : 0,
      viewers: [...b.named.values()].sort(
        (a, c) => RANK[c.confidence] - RANK[a.confidence] || c.views - a.views,
      ),
      unidentified: b.unidentified,
      recipientViewed: null,
    });
  }
  return out;
}
