import type { WorkspaceClient } from "@/lib/db";
import { MAX_RESULTS_PER_KIND, type SearchHit } from "./query";
import { foldText, scoreFields, taxIdMatches, SCORE } from "./fuzzy";
import { listFieldDefsWith } from "@/modules/fields/store";
import { isTextual, readValues, searchableValues } from "@/modules/fields/types";

/**
 * The typo- and accent-tolerant pass (playbook-v2 P3/1).
 *
 * Runs when the exact `contains` search finds nothing useful. Candidates come
 * through the GUARDED client — the tenant guard scopes every query here, as
 * hard rule #1 requires — and the matching happens in process, where accent
 * folding and edit distance are things we can actually express and test.
 *
 * The cost is one broad read per entity. That is why it is a FALLBACK rather
 * than the primary path: an exact match should not pay for it.
 */

/** Ceiling per entity. Above this the fallback stops being cheap. */
const CANDIDATE_LIMIT = 5_000;

/** Below this score a fuzzy hit is noise and would only push real hits down. */
const MIN_SCORE = SCORE.fuzzy - 15;

export async function broadSearch(
  db: WorkspaceClient,
  query: string,
): Promise<SearchHit[]> {
  const q = foldText(query);
  if (q.length < 2) return [];

  // Owner-defined TEXT and URL fields are searchable too (P5/1). Only the
  // textual ones: a number or a checkbox has no words in it, and folding "1"
  // into the corpus would match every lead whose phone contains a one.
  const [leadFieldDefs, leads, companies, documents] = await Promise.all([
    listFieldDefsWith(db, "lead"),
    db.lead.findMany({
      where: { mergedIntoId: null },
      take: CANDIDATE_LIMIT,
      orderBy: { lastActivityAt: "desc" },
      select: {
        id: true,
        contactName: true,
        title: true,
        email: true,
        phone: true,
        stage: true,
        customFields: true,
        company: { select: { name: true } },
      },
    }),
    db.company.findMany({
      where: { mergedIntoId: null },
      take: CANDIDATE_LIMIT,
      orderBy: { name: "asc" },
      select: { id: true, name: true, domain: true, website: true, taxId: true, city: true },
    }),
    db.document.findMany({
      take: CANDIDATE_LIMIT,
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

  const hits: SearchHit[] = [];

  const textualDefs = leadFieldDefs.filter((d) => isTextual(d.type));

  for (const l of leads) {
    const score = scoreFields(query, [
      l.contactName,
      l.email,
      l.title,
      l.phone,
      l.company?.name,
      ...searchableValues(textualDefs, readValues(l.customFields)),
    ]);
    if (score < MIN_SCORE) continue;
    hits.push({
      kind: "lead",
      id: l.id,
      title: l.contactName || l.company?.name || "(unnamed lead)",
      subtitle:
        [l.title, l.company?.name, l.email].filter(Boolean).join(" · ") || l.stage,
      href: `/leads?lead=${l.id}`,
      score,
    });
  }

  for (const c of companies) {
    // A tax id is matched on digits alone, so a pasted "12345678-1-42" finds a
    // stored "12345678142" and vice versa.
    const score = taxIdMatches(query, c.taxId)
      ? SCORE.exact
      : scoreFields(query, [c.name, c.domain, c.website, c.city]);
    if (score < MIN_SCORE) continue;
    hits.push({
      kind: "company",
      id: c.id,
      title: c.name,
      subtitle: [c.domain, c.city, c.taxId].filter(Boolean).join(" · "),
      href: `/leads?company=${c.id}`,
      score,
    });
  }

  for (const d of documents) {
    const score = scoreFields(query, [d.number, d.lead?.company?.name]);
    if (score < MIN_SCORE) continue;
    hits.push({
      kind: "document",
      id: d.id,
      title: d.number || d.type,
      subtitle: [d.type, d.status, d.lead?.company?.name].filter(Boolean).join(" · "),
      href: `/documents?doc=${d.id}`,
      score,
    });
  }

  // Cap per kind so one entity type cannot crowd the others out of a short list.
  const perKind = new Map<string, number>();
  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .filter((hit) => {
      const seen = perKind.get(hit.kind) ?? 0;
      if (seen >= MAX_RESULTS_PER_KIND) return false;
      perKind.set(hit.kind, seen + 1);
      return true;
    });
}
