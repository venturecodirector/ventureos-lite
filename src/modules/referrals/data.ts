import type { WorkspaceClient } from "../../lib/db";
import {
  aggregateReferrals,
  topReferrers,
  type RefLeadFact,
  type ReferrerAgg,
  type ReferrerMeta,
  type TopReferrer,
} from "./ledger";

/**
 * Referral ledger data (spec §4.18). Builds per-lead referral facts (referrer,
 * stage, latest DealOutcome) and joins them into the referrer ledger. Attributed
 * revenue flows from WON DealOutcome values through each lead's referrer.
 */
export interface LedgerLead {
  id: string;
  name: string;
  company: string;
  stage: string;
  result: "won" | "lost" | "postponed" | null;
  value: number;
}

export interface LedgerRow extends ReferrerAgg {
  name: string;
  kind: "person" | "company";
  linkedCompany: string | null;
  leads: LedgerLead[];
}

async function loadFacts(db: WorkspaceClient): Promise<{
  facts: RefLeadFact[];
  leadRows: Map<string, LedgerLead & { referrerId: string | null }>;
}> {
  const leads = await db.lead.findMany({
    where: { referrerId: { not: null } },
    select: {
      id: true,
      referrerId: true,
      stage: true,
      contactName: true,
      company: { select: { name: true } },
    },
  });

  const leadIds = leads.map((l) => l.id);
  const outcomes = leadIds.length
    ? await db.dealOutcome.findMany({
        where: { leadId: { in: leadIds } },
        orderBy: { at: "desc" },
        select: { leadId: true, result: true, value: true },
      })
    : [];
  const latest = new Map<string, { result: string; value: number | null }>();
  for (const o of outcomes) {
    if (!latest.has(o.leadId)) latest.set(o.leadId, { result: o.result, value: o.value });
  }

  const facts: RefLeadFact[] = [];
  const leadRows = new Map<string, LedgerLead & { referrerId: string | null }>();
  for (const l of leads) {
    const o = latest.get(l.id);
    const result = o ? (o.result.toLowerCase() as "won" | "lost" | "postponed") : null;
    const value = o?.value ?? 0;
    facts.push({
      leadId: l.id,
      referrerId: l.referrerId,
      stage: l.stage,
      result,
      value: result === "won" ? value : 0,
    });
    leadRows.set(l.id, {
      id: l.id,
      referrerId: l.referrerId,
      name: l.contactName ?? l.company?.name ?? "Unnamed lead",
      company: l.company?.name ?? "",
      stage: l.stage,
      result,
      value: result === "won" ? value : 0,
    });
  }
  return { facts, leadRows };
}

export async function getReferrerLedger(db: WorkspaceClient): Promise<LedgerRow[]> {
  const [{ facts, leadRows }, referrers] = await Promise.all([
    loadFacts(db),
    db.referrer.findMany({
      include: { linkedCompany: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const aggs = aggregateReferrals(facts);

  const leadsByReferrer = new Map<string, LedgerLead[]>();
  for (const lead of leadRows.values()) {
    if (!lead.referrerId) continue;
    const arr = leadsByReferrer.get(lead.referrerId) ?? [];
    arr.push({ id: lead.id, name: lead.name, company: lead.company, stage: lead.stage, result: lead.result, value: lead.value });
    leadsByReferrer.set(lead.referrerId, arr);
  }

  const empty: ReferrerAgg = {
    referrerId: "",
    referred: 0,
    won: 0,
    lost: 0,
    postponed: 0,
    open: 0,
    attributedRevenue: 0,
  };

  return referrers.map((r) => {
    const a = aggs.get(r.id) ?? { ...empty, referrerId: r.id };
    return {
      ...a,
      name: r.name,
      kind: r.kind === "COMPANY" ? "company" : "person",
      linkedCompany: r.linkedCompany?.name ?? null,
      leads: leadsByReferrer.get(r.id) ?? [],
    };
  });
}

export async function getTopReferrers(db: WorkspaceClient, limit = 5): Promise<TopReferrer[]> {
  const [{ facts }, referrers] = await Promise.all([
    loadFacts(db),
    db.referrer.findMany({ select: { id: true, name: true, kind: true } }),
  ]);
  const aggs = aggregateReferrals(facts);
  const meta = new Map<string, ReferrerMeta>();
  for (const r of referrers) {
    meta.set(r.id, { name: r.name, kind: r.kind === "COMPANY" ? "company" : "person" });
  }
  return topReferrers(aggs, meta, limit);
}
