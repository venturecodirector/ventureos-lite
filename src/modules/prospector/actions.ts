"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { getPlacesClient } from "@/lib/places";
import { callClaude } from "@/lib/ai/call-claude";
import {
  PROSPECT_CLASSIFY_SYSTEM,
  prospectClassificationSchema,
  buildClassifyMessage,
  type ProspectClassification,
} from "@/lib/ai/prompts/prospect-classify";
import { classifyWebsite } from "./website";
import { TEXT_SEARCH_COST_USD } from "./cost";
import { isCacheFresh, CACHE_TTL_DAYS } from "./cache";
import { normalizeDomain } from "../leads/dedupe";
import { findProspectDuplicate } from "./dedupe";
import type { ProspectRow, ProspectSearchResult, SavedSearch } from "./types";

const searchSchema = z.object({
  keyword: z.string().min(1),
  location: z.string().min(1),
  radius: z.string().optional(),
});

function summarize(keyword: string, location: string, rows: ProspectRow[]): string {
  const noWebsite = rows.filter((r) => r.presence !== "has").length;
  return `${rows.length} ${keyword} found in ${location} · ${noWebsite} have no or weak website`;
}

export async function runProspectSearch(raw: unknown): Promise<ProspectSearchResult> {
  const input = searchSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // 30-day cache: don't re-purchase the same area from the Places API.
  const cached = await db.prospectSearch.findFirst({
    where: {
      keywords: input.keyword,
      location: input.location,
      radius: input.radius ?? null,
    },
    orderBy: { ranAt: "desc" },
  });
  if (cached && isCacheFresh(cached.ranAt, new Date())) {
    const results = (cached.results as ProspectRow[] | null) ?? [];
    return {
      fromCache: true,
      searchId: cached.id,
      results,
      summary: summarize(input.keyword, input.location, results),
      costUsd: 0,
    };
  }

  const search = await getPlacesClient().textSearch(input);
  const results: ProspectRow[] = search.results.map((r) => ({
    ...r,
    presence: classifyWebsite(r.websiteUri),
  }));
  const costUsd = search.requestCount * TEXT_SEARCH_COST_USD;

  const now = new Date();
  const rec = await db.prospectSearch.create({
    data: {
      workspaceId,
      keywords: input.keyword,
      location: input.location,
      radius: input.radius,
      cost: costUsd,
      results,
      ranAt: now,
      expiresAt: new Date(now.getTime() + CACHE_TTL_DAYS * 86_400_000),
    },
  });

  revalidatePath("/prospector");
  return {
    fromCache: false,
    searchId: rec.id,
    results,
    summary: summarize(input.keyword, input.location, results),
    costUsd,
  };
}

export async function listSavedSearches(): Promise<SavedSearch[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.prospectSearch.findMany({
    orderBy: { ranAt: "desc" },
    take: 20,
    select: { id: true, keywords: true, location: true },
  });
  const seen = new Set<string>();
  const out: SavedSearch[] = [];
  for (const r of rows) {
    const key = `${r.keywords.toLowerCase()}|${r.location.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, keyword: r.keywords, location: r.location });
  }
  return out;
}

const addSchema = z.object({
  name: z.string().min(1),
  category: z.string().nullish(),
  phone: z.string().nullish(),
  websiteUri: z.string().nullish(),
  address: z.string().nullish(),
});

export async function addProspectAsLead(
  raw: unknown,
): Promise<{ ok: true; leadId: string } | { ok: false; duplicateOf: string }> {
  const input = addSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const existing = await db.company.findMany({
    select: { id: true, domain: true, phone: true },
  });
  const dup = findProspectDuplicate(
    { domain: input.websiteUri ?? null, phone: input.phone ?? null },
    existing,
  );
  if (dup) return { ok: false, duplicateOf: dup.id };

  const company = await db.company.create({
    data: {
      workspaceId,
      name: input.name,
      domain: normalizeDomain(input.websiteUri) ?? undefined,
      phone: input.phone ?? undefined,
      industry: input.category ?? undefined,
      address: input.address ?? undefined,
    },
  });
  // Unnamed contact — filled in later (spec §4.3).
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      source: "PROSPECTOR",
      stage: "RESEARCHED",
    },
  });

  revalidatePath("/leads");
  return { ok: true, leadId: lead.id };
}

export async function classifyProspects(
  searchId: string,
): Promise<{ classified: number }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const search = await db.prospectSearch.findUnique({ where: { id: searchId } });
  if (!search) throw new Error("Search not found");

  const rows = (search.results as ProspectRow[] | null) ?? [];
  const batch = rows.slice(0, 25).map((r, index) => ({
    index,
    name: r.name,
    category: r.category,
    website: r.presence,
  }));

  const { data } = await callClaude({
    useCase: "prospect_classify",
    workspaceId,
    system: PROSPECT_CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: buildClassifyMessage(batch) }],
    schema: prospectClassificationSchema,
  });
  const classification = data as ProspectClassification;

  const byIndex = new Map(classification.items.map((it) => [it.index, it]));
  const merged: ProspectRow[] = rows.map((r, i) => {
    const c = byIndex.get(i);
    return c ? { ...r, classification: { fit: c.fit, priority: c.priority } } : r;
  });
  await db.prospectSearch.update({
    where: { id: searchId },
    data: { results: merged },
  });

  revalidatePath("/prospector");
  return { classified: classification.items.length };
}
