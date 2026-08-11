import type { WorkspaceClient } from "../../lib/db";
import { PIPELINE_STAGES } from "../pipeline/transitions";
import { getFunnel } from "./data";
import type { WeeklyReportInput, SourceFact, QuoteFact } from "./reports";

/**
 * Collect the deterministic weekly-report numbers from the DB (spec §4.14).
 * Everything here is computed from data — no AI, no manual input. The Haiku
 * commentary and Fanni's comment are layered on by the caller.
 */
const stageIndex = (stage: string) => PIPELINE_STAGES.indexOf(stage as never);
const CONTACTED_IDX = PIPELINE_STAGES.indexOf("CONTACTED" as never);
const REPLIED_IDX = PIPELINE_STAGES.indexOf("REPLIED" as never);
const MEETING_IDX = PIPELINE_STAGES.indexOf("MEETING_BOOKED" as never);

export async function collectReportInput(
  db: WorkspaceClient,
  opts: { weekLabel: string; sinceMs: number; untilMs: number },
): Promise<WeeklyReportInput> {
  const since = new Date(opts.sinceMs);
  const until = new Date(opts.untilMs);

  const [funnel, leads, outboundCount, inboundThisWeek, meetingsThisWeek, targets, audits, quotes, outcomes] =
    await Promise.all([
      getFunnel(db),
      db.lead.findMany({
        select: { id: true, source: true, stage: true, companyId: true },
      }),
      db.message.count({ where: { direction: "OUTBOUND", sentAt: { gte: since, lt: until } } }),
      db.message.count({ where: { direction: "INBOUND", createdAt: { gte: since, lt: until } } }),
      db.meeting.count({ where: { createdAt: { gte: since, lt: until } } }),
      db.target.findMany({ where: { period: "weekly" } }),
      db.auditResult.findMany({ where: { status: "done" }, select: { companyId: true } }),
      db.document.findMany({
        where: { type: "QUOTE" },
        select: {
          id: true,
          createdAt: true,
          acceptances: { select: { at: true }, orderBy: { at: "asc" }, take: 1 },
          chainChild: { where: { type: "CONTRACT" }, select: { finalizedAt: true, createdAt: true } },
        },
      }),
      db.dealOutcome.findMany({ orderBy: { at: "desc" }, select: { leadId: true, result: true, value: true } }),
    ]);

  // Latest outcome per lead.
  const latestOutcome = new Map<string, { result: string; value: number | null }>();
  for (const o of outcomes) if (!latestOutcome.has(o.leadId)) latestOutcome.set(o.leadId, o);

  // Per-source facts.
  const sources: SourceFact[] = leads.map((l) => {
    const idx = stageIndex(l.stage);
    const o = latestOutcome.get(l.id);
    return {
      source: l.source,
      contacted: idx >= CONTACTED_IDX && idx >= 0,
      replied: idx >= REPLIED_IDX && idx >= 0,
      won: o?.result === "WON",
      revenue: o?.result === "WON" ? o.value ?? 0 : 0,
    };
  });

  // KPIs vs weekly targets (deterministic this-week values).
  const contacted = sources.filter((s) => s.contacted).length;
  const accepted = leads.filter((l) => stageIndex(l.stage) >= PIPELINE_STAGES.indexOf("ACCEPTED" as never) && stageIndex(l.stage) >= 0).length;
  const replied = sources.filter((s) => s.replied).length;
  const targetFor = (metric: string) => targets.find((t) => t.metric === metric)?.value ?? null;
  const kpis = [
    { metric: "invites_sent", value: outboundCount, target: targetFor("invites_sent") },
    { metric: "acceptance_rate", value: contacted ? Math.round((accepted / contacted) * 100) : 0, target: targetFor("acceptance_rate") },
    { metric: "reply_rate", value: contacted ? Math.round((replied / contacted) * 100) : 0, target: targetFor("reply_rate") },
    { metric: "meetings_booked", value: meetingsThisWeek, target: targetFor("meetings_booked") },
    { metric: "replies_logged", value: inboundThisWeek, target: null },
  ];

  // Audit → meeting.
  const auditedCompanies = new Set(audits.map((a) => a.companyId).filter((v): v is string => !!v));
  const auditedLeadsArr = leads.filter((l) => l.companyId && auditedCompanies.has(l.companyId));
  const auditedLeadsWithMeeting = auditedLeadsArr.filter((l) => stageIndex(l.stage) >= MEETING_IDX && stageIndex(l.stage) >= 0).length;

  // Document chain.
  const quoteFacts: QuoteFact[] = quotes.map((q) => {
    const contract = q.chainChild[0];
    const signedAt = contract?.finalizedAt ?? contract?.createdAt ?? null;
    return {
      createdAtMs: q.createdAt.getTime(),
      acceptedAtMs: q.acceptances[0]?.at.getTime() ?? null,
      signedAtMs: signedAt ? signedAt.getTime() : null,
    };
  });

  return {
    weekLabel: opts.weekLabel,
    kpis,
    funnel,
    sources,
    audit: { auditedLeads: auditedLeadsArr.length, auditedLeadsWithMeeting },
    quotes: quoteFacts,
  };
}
