"use server";

import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import {
  MAX_RESULTS_PER_KIND,
  bestRank,
  isSearchable,
  normalizeQuery,
  orderHits,
  taxIdCore,
  taxIdDigits,
  type SearchHit,
} from "./query";
import { broadSearch } from "./broad";

/**
 * Global search (spec §4.1). Leads, companies and documents in the CURRENT
 * workspace only — every query goes through `getWorkspaceClient`, so the tenant
 * guard scopes it and there is no path to another workspace's rows
 * (CLAUDE.md hard rule #1).
 *
 * No AI involved: this is three indexed `contains` queries, so it is cheap
 * enough to run on every keystroke (debounced client-side) and costs nothing
 * against the Claude budget.
 */

/**
 * Postgres `contains` is case-sensitive and needs `mode: "insensitive"`; MySQL
 * is case-insensitive under its default collation and rejects the argument.
 * The schema has to run on both (CLAUDE.md → Stack), so the flag is applied
 * per flavour rather than hardcoded.
 */
function like(value: string): { contains: string; mode?: "insensitive" } {
  const insensitive = (process.env.DB_FLAVOR ?? "postgres") === "postgres";
  return insensitive ? { contains: value, mode: "insensitive" } : { contains: value };
}

const schema = z.object({ q: z.string().max(200) });

export async function searchWorkspace(raw: unknown): Promise<SearchHit[]> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return [];

  const q = normalizeQuery(parsed.data.q);
  if (!isSearchable(q)) return [];

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // The 8-digit core matches a stored id in any punctuation form.
  const taxCore = taxIdCore(q);

  const [leads, companies, documents] = await Promise.all([
    db.lead.findMany({
      where: {
        OR: [
          { contactName: like(q) },
          { email: like(q) },
          { phone: like(q) },
          { title: like(q) },
          { company: { name: like(q) } },
        ],
      },
      take: MAX_RESULTS_PER_KIND * 2,
      orderBy: { lastActivityAt: "desc" },
      select: {
        id: true,
        contactName: true,
        title: true,
        email: true,
        stage: true,
        company: { select: { name: true } },
      },
    }),
    db.company.findMany({
      where: {
        OR: [
          { name: like(q) },
          { domain: like(q) },
          { website: like(q) },
          { city: like(q) },
          // Tax ids are stored as typed, usually "12345678-1-42". A `contains`
          // cannot match a digits-only query against a dashed column, so match
          // the raw string AND the 8-digit core — which is what people type
          // when they leave the suffix off, and the only part that is stable.
          { taxId: like(q) },
          ...(taxCore ? [{ taxId: like(taxCore) }] : []),
        ],
      },
      take: MAX_RESULTS_PER_KIND * 2,
      orderBy: { name: "asc" },
      select: { id: true, name: true, domain: true, website: true, taxId: true, city: true },
    }),
    db.document.findMany({
      where: {
        OR: [{ number: like(q) }, { lead: { company: { name: like(q) } } }],
      },
      take: MAX_RESULTS_PER_KIND * 2,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        lead: { select: { company: { select: { name: true } } } },
      },
    }),
  ]);

  const hits: SearchHit[] = [
    ...leads.map((l) => ({
      kind: "lead" as const,
      id: l.id,
      title: l.contactName || l.company?.name || "(unnamed lead)",
      subtitle: [l.title, l.company?.name, l.email].filter(Boolean).join(" · ") || l.stage,
      href: `/leads?lead=${l.id}`,
      score: bestRank([l.contactName, l.email, l.title, l.company?.name], q),
    })),
    ...companies.map((c) => ({
      kind: "company" as const,
      id: c.id,
      title: c.name,
      subtitle: [c.domain, c.city, c.taxId].filter(Boolean).join(" · ") || "Company",
      href: `/leads?company=${c.id}`,
      // An exact tax-id hit is unambiguous — rank it above any name match.
      score: taxCore && c.taxId && taxIdDigits(c.taxId).startsWith(taxCore)
        ? 120
        : bestRank([c.name, c.domain, c.website ?? null, c.taxId, c.city], q),
    })),
    ...documents.map((d) => ({
      kind: "document" as const,
      id: d.id,
      title: d.number || `${d.type} ${d.id.slice(0, 6)}`,
      subtitle: [d.lead?.company?.name, d.type, d.status].filter(Boolean).join(" · "),
      href: `/documents?doc=${d.id}`,
      score: bestRank([d.number, d.lead?.company?.name], q),
    })),
  ].filter((h) => h.score > 0);

  // The exact pass is fast and covers most searches. When it finds nothing, fall
  // back to the accent- and typo-tolerant pass (P3/1) — which reads more rows,
  // so an exact match must never pay for it.
  if (hits.length === 0) {
    return orderHits(await broadSearch(db, q));
  }

  return orderHits(hits);
}
