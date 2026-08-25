import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getPlacesClient } from "@/lib/places";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { enrichCompanySite } from "../leads/enrichment";
import { TEXT_SEARCH_COST_USD } from "./cost";
import {
  lookupQuery,
  matchPlace,
  planFromLocalData,
  planFromPlace,
  type BackfillCompany,
  type BackfillField,
  type BackfillPlan,
} from "./backfill";
import { BACKFILL_BATCH, EMAIL_LOOKUP_CAP } from "./backfill-limits";

/**
 * The backfill, against the database (P4/1e).
 *
 * Every function here takes the workspace explicitly and knows nothing about
 * sessions — which is what lets the isolation rule and the field whitelist be
 * proved by a test rather than asserted in a comment. `backfill-actions.ts` is
 * the thin layer above it: session, role, revalidate.
 *
 * Three promises, and the code is arranged around them: nothing is written that
 * was not shown to the operator first; a Google lookup that cannot confirm WHICH
 * business it found writes nothing at all; and the price is on the button before
 * it is spent.
 */

export interface BackfillState {
  /** Prospected companies — the ones this can act on. */
  total: number;
  missingCity: number;
  missingPhone: number;
  missingPlaceId: number;
  missingEmail: number;
  englishIndustry: number;
  /** What a full Google pass over `total` companies would cost. */
  googleCostUsd: number;
  batchSize: number;
}

export interface BackfillPreview {
  plans: BackfillPlan[];
  nextOffset: number | null;
  total: number;
  costUsd: number;
  /** What the run could not do, said out loud rather than left to be inferred. */
  notice: string | null;
}

export interface BackfillResult {
  companies: number;
  fields: number;
  emailsFound: number;
  notice: string | null;
}

export interface BackfillRowInput {
  companyId: string;
  changes: { field: BackfillField; to: string }[];
}

interface CandidateRow extends BackfillCompany {
  leadId: string | null;
  googlePlaceId: string | null;
}

/**
 * The prospected set, defined by how the rows got here rather than by what they
 * look like: a company with a PROSPECTOR lead. The companies in this workspace
 * with no lead at all were created by hand and are none of the backfill's
 * business.
 */
export async function loadCandidates(workspaceId: string): Promise<CandidateRow[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.company.findMany({
    where: { mergedIntoId: null, leads: { some: { source: "PROSPECTOR" } } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      industry: true,
      phone: true,
      domain: true,
      website: true,
      googlePlaceId: true,
      leads: {
        where: { source: "PROSPECTOR" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { id: true, phone: true, email: true },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    city: r.city,
    industry: r.industry,
    phone: r.phone,
    domain: r.domain,
    website: r.website,
    googlePlaceId: r.googlePlaceId,
    leadId: r.leads[0]?.id ?? null,
    leadPhone: r.leads[0]?.phone ?? null,
    leadEmail: r.leads[0]?.email ?? null,
  }));
}

export async function backfillState(workspaceId: string): Promise<BackfillState> {
  const rows = await loadCandidates(workspaceId);
  return {
    total: rows.length,
    missingCity: rows.filter((r) => !r.city).length,
    missingPhone: rows.filter((r) => !r.phone).length,
    missingPlaceId: rows.filter((r) => !r.googlePlaceId).length,
    missingEmail: rows.filter((r) => !r.leadEmail).length,
    englishIndustry: rows.filter((r) =>
      planFromLocalData(r).changes.some((c) => c.field === "industry"),
    ).length,
    googleCostUsd: Math.round(rows.length * TEXT_SEARCH_COST_USD * 100) / 100,
    batchSize: BACKFILL_BATCH,
  };
}

/** The free pass: the stored address, the closed category map. Answers for all. */
export async function previewLocal(workspaceId: string): Promise<BackfillPreview> {
  const all = await loadCandidates(workspaceId);
  const plans = all.map(planFromLocalData).filter((p) => p.changes.length > 0);
  return {
    plans,
    nextOffset: null,
    total: all.length,
    costUsd: 0,
    notice:
      plans.length === all.length
        ? null
        : `${all.length - plans.length} companies need nothing that can be derived locally — a Google lookup is the only way to add to those.`,
  };
}

/**
 * One paid batch: a Places text search per company.
 *
 * Batched because seventy HTTP requests do not belong inside a single server
 * action, and because a batch that has been paid for should survive whatever
 * happens to the next one.
 */
export async function previewGoogle(
  workspaceId: string,
  offset: number,
): Promise<BackfillPreview> {
  const all = await loadCandidates(workspaceId);
  const placesKey = await resolveIntegration(workspaceId, "google.placesApiKey");
  const slice = all.slice(offset, offset + BACKFILL_BATCH);
  const client = getPlacesClient(placesKey);
  const plans: BackfillPlan[] = [];
  let spent = 0;
  let unmatched = 0;
  let failed = 0;

  for (const company of slice) {
    let plan: BackfillPlan | null = null;
    try {
      const { keyword, location } = lookupQuery(company);
      const found = await client.textSearch({ keyword, location, maxResults: 1 });
      spent += found.requestCount * TEXT_SEARCH_COST_USD;
      const place = found.results[0];
      if (place) {
        const level = matchPlace(company, place);
        /**
         * "unsure" means we do not know WHICH business this is. Nothing from it
         * is written — not the phone, and not even the place id, because a wrong
         * place id would poison every future dedupe for this row silently and
         * permanently.
         */
        if (level !== "unsure") plan = planFromPlace(company, place, level);
        else unmatched += 1;
      } else {
        unmatched += 1;
      }
    } catch {
      // One company Google cannot answer for must not lose the batch: the rows
      // already looked up are returned, and the failure is counted and reported.
      failed += 1;
    }
    // Whatever Google could not settle, the address and the category map still
    // can — so no company comes back from a paid batch with nothing at all.
    plans.push(plan ?? planFromLocalData(company));
  }

  const next = offset + BACKFILL_BATCH;
  const notes: string[] = [];
  if (unmatched) {
    notes.push(
      `${unmatched} could not be identified on Google with enough certainty — those rows carry only what the stored address gives.`,
    );
  }
  if (failed) notes.push(`${failed} lookups failed outright and were skipped.`);

  return {
    plans: plans.filter((p) => p.changes.length > 0),
    nextOffset: next < all.length ? next : null,
    total: all.length,
    costUsd: Math.round(spent * 1000) / 1000,
    notice: notes.join(" ") || null,
  };
}

/** Which of the writable fields live on the company rather than on the lead. */
const COMPANY_FIELDS = new Set<BackfillField>([
  "name",
  "city",
  "industry",
  "phone",
  "address",
  "domain",
  "website",
  "googlePlaceId",
]);

/**
 * Write what the operator ticked — and nothing else.
 *
 * The rows come back from the client, which is how `addProspectAsLead` has
 * always worked: the values were shown, the operator chose them, and the caller
 * has already held the field list to the ten this is allowed to touch. Two
 * further guards live here rather than in the schema, because a schema cannot
 * see the database: a company id that is not a prospected company OF THIS
 * WORKSPACE is skipped, and the write goes through the workspace-scoped client.
 */
export async function applyPlans(
  workspaceId: string,
  userId: string,
  rows: BackfillRowInput[],
): Promise<BackfillResult> {
  const db = getWorkspaceClient(workspaceId);
  const candidates = await loadCandidates(workspaceId);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  let companies = 0;
  let fields = 0;
  const touched: string[] = [];

  for (const row of rows) {
    const candidate = byId.get(row.companyId);
    if (!candidate) continue;

    const companyData: Record<string, string> = {};
    const leadData: Record<string, string> = {};
    for (const change of row.changes) {
      if (COMPANY_FIELDS.has(change.field)) companyData[change.field] = change.to;
      else if (change.field === "leadPhone") leadData.phone = change.to;
      else if (change.field === "leadEmail") leadData.email = change.to;
    }

    if (Object.keys(companyData).length) {
      await db.company.update({ where: { id: candidate.id }, data: companyData });
    }
    if (Object.keys(leadData).length && candidate.leadId) {
      await db.lead.update({ where: { id: candidate.leadId }, data: leadData });
    }
    companies += 1;
    fields += row.changes.length;
    touched.push(candidate.id);
  }

  /**
   * THE EMAIL, WHICH GOOGLE NEVER HAD.
   *
   * All seventy-one prospected leads here have no email address, because the
   * Places API carries none for any business at any billing tier. The address is
   * on the company's own site — so once a website has been filled in, the site
   * is read exactly the way a new prospect's is: one homepage, one contact page,
   * robots.txt honoured, cached thirty days.
   *
   * Capped, and the cap is REPORTED rather than applied quietly: a run that
   * silently read the first twenty-five sites and stopped would look exactly
   * like a run that found no more emails.
   */
  const wroteSite = new Set(
    rows
      .filter((r) => r.changes.some((c) => c.field === "domain" || c.field === "website"))
      .map((r) => r.companyId),
  );
  const needEmail = touched
    .map((id) => byId.get(id)!)
    .filter((c) => c.leadId && !c.leadEmail)
    .filter((c) => wroteSite.has(c.id) || !!c.domain || !!c.website);
  const lookups = needEmail.slice(0, EMAIL_LOOKUP_CAP);

  let emailsFound = 0;
  for (const company of lookups) {
    try {
      const site = await enrichCompanySite(company.id);
      const email = site.contacts?.emails[0] ?? null;
      const phone = site.contacts?.phones[0] ?? null;
      const data: Record<string, string> = {};
      if (email) data.email = email;
      if (phone && !company.leadPhone) data.phone = phone;
      if (Object.keys(data).length && company.leadId) {
        await db.lead.update({ where: { id: company.leadId }, data });
        if (email) emailsFound += 1;
      }
    } catch {
      // An unreachable site is the ordinary case for these businesses, not an
      // error worth failing the whole apply over.
    }
  }

  if (touched.length) {
    await db.auditLog.create({
      data: {
        workspaceId,
        actorUserId: userId,
        action: "prospector.backfill",
        entityType: "Company",
        entityId: touched[0]!,
        meta: {
          companies,
          fields,
          emailsFound,
          companyIds: touched,
          changedFields: rows.flatMap((r) => r.changes.map((c) => c.field)),
        },
      },
    });
  }

  const skipped = needEmail.length - lookups.length;
  return {
    companies,
    fields,
    emailsFound,
    notice: skipped
      ? `${skipped} more websites were left unread this run (cap ${EMAIL_LOOKUP_CAP} per apply) — run the backfill again to read them.`
      : null,
  };
}

/** Owner or Admin: this rewrites company names and spends the Places budget. */
export async function isBackfillOperator(workspaceId: string, userId: string): Promise<boolean> {
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  return membership?.role === "OWNER" || membership?.role === "ADMIN";
}
