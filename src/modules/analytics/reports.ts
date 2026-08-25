/**
 * Analytics report builders (spec §4.14 / §4.22). Pure and deterministic: the
 * weekly report renders entirely from data — no human input required. Fanni's
 * comment and the Haiku "what worked" commentary are layered on separately, so
 * the numbers stand alone. The Monday digest model is likewise pure.
 */

// ---- funnel ---------------------------------------------------------------

export interface FunnelStep {
  stage: string;
  count: number;
}
export interface FunnelStepConv extends FunnelStep {
  conversion: number | null; // vs previous step
}

export function funnelConversion(funnel: FunnelStep[]): FunnelStepConv[] {
  return funnel.map((f, i) => {
    const prev = i > 0 ? funnel[i - 1].count : null;
    return { ...f, conversion: prev && prev > 0 ? f.count / prev : i === 0 ? null : 0 };
  });
}

// ---- per-source performance -----------------------------------------------

export interface SourceFact {
  source: string;
  contacted: boolean;
  replied: boolean;
  won: boolean;
  revenue: number;
}
export interface SourceRow {
  source: string;
  leads: number;
  contacted: number;
  replied: number;
  won: number;
  revenue: number;
  replyRate: number; // replied / contacted
  winRate: number; // won / contacted
}

export function perSourcePerformance(facts: SourceFact[]): SourceRow[] {
  const map = new Map<string, SourceRow>();
  for (const f of facts) {
    let r = map.get(f.source);
    if (!r) {
      r = { source: f.source, leads: 0, contacted: 0, replied: 0, won: 0, revenue: 0, replyRate: 0, winRate: 0 };
      map.set(f.source, r);
    }
    r.leads += 1;
    if (f.contacted) r.contacted += 1;
    if (f.replied) r.replied += 1;
    if (f.won) r.won += 1;
    r.revenue += f.revenue;
  }
  const rows = [...map.values()];
  for (const r of rows) {
    r.replyRate = r.contacted > 0 ? r.replied / r.contacted : 0;
    r.winRate = r.contacted > 0 ? r.won / r.contacted : 0;
  }
  rows.sort((a, b) => b.revenue - a.revenue || b.leads - a.leads || a.source.localeCompare(b.source));
  return rows;
}

// ---- audit → meeting ------------------------------------------------------

export interface AuditToMeeting {
  audited: number;
  meetings: number;
  rate: number;
}

export function auditToMeeting(input: {
  auditedLeads: number;
  auditedLeadsWithMeeting: number;
}): AuditToMeeting {
  const { auditedLeads, auditedLeadsWithMeeting } = input;
  return {
    audited: auditedLeads,
    meetings: auditedLeadsWithMeeting,
    rate: auditedLeads > 0 ? auditedLeadsWithMeeting / auditedLeads : 0,
  };
}

// ---- document chain -------------------------------------------------------

export interface QuoteFact {
  createdAtMs: number;
  acceptedAtMs: number | null;
  signedAtMs: number | null; // contract signed/accepted
}
export interface DocChainMetrics {
  quotes: number;
  accepted: number;
  acceptanceRate: number;
  avgDaysToSigned: number | null;
}

export function docChainMetrics(quotes: QuoteFact[]): DocChainMetrics {
  const total = quotes.length;
  const accepted = quotes.filter((q) => q.acceptedAtMs != null).length;
  const signed = quotes.filter((q) => q.signedAtMs != null);
  const avgDaysToSigned = signed.length
    ? signed.reduce((s, q) => s + (q.signedAtMs! - q.createdAtMs) / 86_400_000, 0) / signed.length
    : null;
  return {
    quotes: total,
    accepted,
    acceptanceRate: total > 0 ? accepted / total : 0,
    avgDaysToSigned,
  };
}

// ---- weekly report --------------------------------------------------------

export interface WeeklyReportInput {
  weekLabel: string;
  kpis: Array<{ metric: string; value: number; target: number | null }>;
  funnel: FunnelStep[];
  sources: SourceFact[];
  audit: { auditedLeads: number; auditedLeadsWithMeeting: number };
  quotes: QuoteFact[];
}

export interface WeeklyReport {
  weekLabel: string;
  kpis: Array<{ metric: string; value: number; target: number | null; pct: number | null }>;
  funnel: FunnelStepConv[];
  sources: SourceRow[];
  auditToMeeting: AuditToMeeting;
  docChain: DocChainMetrics;
}

/** Deterministic — every field derives from `input`. No manual step. */
export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  return {
    weekLabel: input.weekLabel,
    kpis: input.kpis.map((k) => ({
      ...k,
      pct: k.target && k.target > 0 ? k.value / k.target : null,
    })),
    funnel: funnelConversion(input.funnel),
    sources: perSourcePerformance(input.sources),
    auditToMeeting: auditToMeeting(input.audit),
    docChain: docChainMetrics(input.quotes),
  };
}

// ---- Monday digest model --------------------------------------------------

export interface DigestInput {
  todayQueueCount: number;
  dueCallbacks: number;
  overdueFollowups: number;
  pipelineAdvances: number;
  pendingApprovals: number;
  topReferrer: { name: string; revenue: number } | null;
  isOwner: boolean;
  /** Clients scored red by the health rules (playbook-v3 P11/1c). */
  redClients?: number;
  /**
   * Delivery milestones past their date (playbook-v3 P11/2c).
   *
   * The one that matters most is the certificate: a project whose work is
   * finished but whose teljesítésigazolás was never issued is an invoice that
   * cannot go out, and it is invisible because everything else looks done.
   */
  overdueMilestones?: number;
  /**
   * Unread notifications whose type this user has left on for the email digest
   * (playbook-v2 P6/1). The digest is the EMAIL channel: the playbook is
   * explicit that a notification must never become a message per event, so it
   * arrives here as one batched line.
   */
  unreadNotifications?: number;
}
export interface DigestSection {
  key: string;
  label: string;
  value: string;
}
export interface DigestModel {
  sections: DigestSection[];
}

export function buildDigestModel(input: DigestInput): DigestModel {
  const sections: DigestSection[] = [
    { key: "todayQueue", label: "Today Queue", value: `${input.todayQueueCount} items` },
    { key: "dueCallbacks", label: "Due callbacks", value: `${input.dueCallbacks}` },
    { key: "overdueFollowups", label: "Overdue follow-ups", value: `${input.overdueFollowups}` },
    { key: "pipelineAdvances", label: "Pipeline advances (7d)", value: `${input.pipelineAdvances}` },
  ];
  if (input.isOwner) {
    sections.push({ key: "pendingApprovals", label: "Pending approvals", value: `${input.pendingApprovals}` });
  }
  // Red clients earn a line only when there are some — a standing "0" is a
  // line people stop reading, and this one has to be noticed.
  if (input.redClients && input.redClients > 0) {
    sections.push({
      key: "redClients",
      label: "Clients needing attention",
      value: `${input.redClients}`,
    });
  }
  if (input.overdueMilestones && input.overdueMilestones > 0) {
    sections.push({
      key: "overdueMilestones",
      label: "Overdue project milestones",
      value: `${input.overdueMilestones}`,
    });
  }
  // Only when there is something: a permanent "Unread notifications: 0" line
  // trains people to skip the whole block.
  if (input.unreadNotifications && input.unreadNotifications > 0) {
    sections.push({
      key: "notifications",
      label: "Unread notifications",
      value: `${input.unreadNotifications}`,
    });
  }
  sections.push({
    key: "topReferrer",
    label: "Top referrer",
    value: input.topReferrer
      ? `${input.topReferrer.name} (${input.topReferrer.revenue.toLocaleString("en-US")} HUF)`
      : "—",
  });
  return { sections };
}
