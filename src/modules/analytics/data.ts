import type { WorkspaceClient } from "../../lib/db";
import { scoreBand } from "./taxonomy";
import type { OutcomeFact } from "./aggregate";
import { PIPELINE_STAGES } from "../pipeline/transitions";

/**
 * Build "what closes" facts from the DB (spec §4.20). One fact per lead, using
 * the LATEST DealOutcome per lead. Dimensions: hook (last outbound message
 * kind), signals (lead.signals[]), source, segment (company industry), and the
 * audit-score band of the company's most recent audit.
 */
export interface OutcomeTotals {
  deals: number;
  won: number;
  lost: number;
  postponed: number;
  revenue: number;
}

export interface OutcomeFactsResult {
  facts: OutcomeFact[];
  totals: OutcomeTotals;
}

export async function getOutcomeFacts(
  db: WorkspaceClient,
  opts?: { sinceMs?: number; untilMs?: number },
): Promise<OutcomeFactsResult> {
  const at =
    opts?.sinceMs || opts?.untilMs
      ? {
          ...(opts.sinceMs ? { gte: new Date(opts.sinceMs) } : {}),
          ...(opts.untilMs ? { lt: new Date(opts.untilMs) } : {}),
        }
      : undefined;
  const where = at ? { at } : {};
  const outcomes = await db.dealOutcome.findMany({
    where,
    orderBy: { at: "desc" },
    include: { lead: { include: { company: true } } },
  });

  // Latest outcome per lead.
  const latest = new Map<string, (typeof outcomes)[number]>();
  for (const o of outcomes) {
    if (!latest.has(o.leadId)) latest.set(o.leadId, o);
  }
  const rows = [...latest.values()];

  const companyIds = [
    ...new Set(rows.map((o) => o.lead?.companyId).filter((v): v is string => !!v)),
  ];
  const leadIds = rows.map((o) => o.leadId);

  // Latest audit score per company (one query, reduced in memory).
  const audits = companyIds.length
    ? await db.auditResult.findMany({
        where: { companyId: { in: companyIds }, status: "done" },
        orderBy: { createdAt: "desc" },
        select: { companyId: true, score: true },
      })
    : [];
  const scoreByCompany = new Map<string, number>();
  for (const a of audits) {
    if (a.companyId && !scoreByCompany.has(a.companyId)) scoreByCompany.set(a.companyId, a.score);
  }

  // Last outbound message kind per lead (hook proxy).
  const messages = leadIds.length
    ? await db.message.findMany({
        where: { leadId: { in: leadIds }, direction: "OUTBOUND" },
        orderBy: { createdAt: "desc" },
        select: { leadId: true, kind: true },
      })
    : [];
  const hookByLead = new Map<string, string>();
  for (const m of messages) {
    if (m.kind && !hookByLead.has(m.leadId)) hookByLead.set(m.leadId, m.kind);
  }

  const facts: OutcomeFact[] = [];
  const totals: OutcomeTotals = { deals: 0, won: 0, lost: 0, postponed: 0, revenue: 0 };

  for (const o of rows) {
    const result = String(o.result).toLowerCase() as OutcomeFact["result"];
    const value = o.value ?? 0;
    const company = o.lead?.company ?? null;
    const signals = Array.isArray(o.lead?.signals) ? (o.lead!.signals as string[]) : [];
    const band = scoreBand(company ? scoreByCompany.get(company.id) ?? null : null);

    facts.push({
      result,
      value: result === "won" ? value : 0,
      dims: {
        hook: hookByLead.get(o.leadId) ?? null,
        signals: signals.filter((s) => typeof s === "string"),
        source: o.lead?.source ?? null,
        segment: company?.industry ?? company?.sizeBand ?? null,
        scoreBand: band,
      },
    });

    totals.deals += 1;
    if (result === "won") {
      totals.won += 1;
      totals.revenue += value;
    } else if (result === "lost") totals.lost += 1;
    else totals.postponed += 1;
  }

  return { facts, totals };
}

/** Simple funnel: lead counts per pipeline stage, in flow order. */
export async function getFunnel(
  db: WorkspaceClient,
): Promise<Array<{ stage: string; count: number }>> {
  const grouped = await db.lead.groupBy({ by: ["stage"], _count: { _all: true } });
  const counts = new Map<string, number>();
  for (const g of grouped) counts.set(g.stage, g._count._all);
  return PIPELINE_STAGES.map((s) => ({ stage: s, count: counts.get(s) ?? 0 }));
}
