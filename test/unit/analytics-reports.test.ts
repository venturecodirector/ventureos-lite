import { describe, it, expect } from "vitest";
import {
  funnelConversion,
  perSourcePerformance,
  auditToMeeting,
  docChainMetrics,
  buildWeeklyReport,
  buildDigestModel,
  type WeeklyReportInput,
  type SourceFact,
  type QuoteFact,
} from "../../src/modules/analytics/reports";

describe("funnel per-step conversion", () => {
  it("computes conversion vs the previous step", () => {
    const rows = funnelConversion([
      { stage: "RESEARCHED", count: 100 },
      { stage: "CONTACTED", count: 60 },
      { stage: "REPLIED", count: 15 },
    ]);
    expect(rows[0].conversion).toBeNull();
    expect(rows[1].conversion).toBeCloseTo(0.6, 5);
    expect(rows[2].conversion).toBeCloseTo(0.25, 5);
  });
});

describe("per-source performance (prospector / linkedin / manual / referral / cold_email)", () => {
  const facts: SourceFact[] = [
    { source: "PROSPECTOR", contacted: true, replied: true, won: true, revenue: 2_000_000 },
    { source: "PROSPECTOR", contacted: true, replied: false, won: false, revenue: 0 },
    { source: "REFERRAL", contacted: true, replied: true, won: false, revenue: 0 },
  ];
  it("aggregates leads / reply rate / win rate / revenue by source", () => {
    const rows = perSourcePerformance(facts);
    const p = rows.find((r) => r.source === "PROSPECTOR")!;
    expect(p.leads).toBe(2);
    expect(p.replied).toBe(1);
    expect(p.replyRate).toBeCloseTo(0.5, 5);
    expect(p.won).toBe(1);
    expect(p.revenue).toBe(2_000_000);
    // ranked by revenue
    expect(rows[0].source).toBe("PROSPECTOR");
  });
});

describe("audit-to-meeting conversion", () => {
  it("is meetings / audited leads, guarded", () => {
    expect(auditToMeeting({ auditedLeads: 20, auditedLeadsWithMeeting: 5 }).rate).toBeCloseTo(0.25, 5);
    expect(auditToMeeting({ auditedLeads: 0, auditedLeadsWithMeeting: 0 }).rate).toBe(0);
  });
});

describe("document-chain metrics", () => {
  const day = 86_400_000;
  const quotes: QuoteFact[] = [
    { createdAtMs: 0, acceptedAtMs: 2 * day, signedAtMs: 4 * day },
    { createdAtMs: 0, acceptedAtMs: 6 * day, signedAtMs: null },
    { createdAtMs: 0, acceptedAtMs: null, signedAtMs: null },
  ];
  it("computes acceptance rate and average days quote→signed", () => {
    const m = docChainMetrics(quotes);
    expect(m.quotes).toBe(3);
    expect(m.accepted).toBe(2);
    expect(m.acceptanceRate).toBeCloseTo(2 / 3, 5);
    expect(m.avgDaysToSigned).toBeCloseTo(4, 5); // only the one signed quote
  });
  it("returns null avg when nothing is signed yet", () => {
    expect(docChainMetrics([{ createdAtMs: 0, acceptedAtMs: null, signedAtMs: null }]).avgDaysToSigned).toBeNull();
  });
});

describe("weekly report renders with ZERO manual steps (spec §4.14)", () => {
  const input: WeeklyReportInput = {
    weekLabel: "week 33",
    kpis: [
      { metric: "invites_sent", value: 84, target: 100 },
      { metric: "acceptance_rate", value: 31, target: 35 },
      { metric: "reply_rate", value: 14, target: null },
    ],
    funnel: [
      { stage: "RESEARCHED", count: 100 },
      { stage: "CONTACTED", count: 60 },
    ],
    sources: [{ source: "PROSPECTOR", contacted: true, replied: true, won: true, revenue: 500_000 }],
    audit: { auditedLeads: 10, auditedLeadsWithMeeting: 3 },
    quotes: [{ createdAtMs: 0, acceptedAtMs: 86_400_000, signedAtMs: 2 * 86_400_000 }],
  };

  it("produces a complete report purely from data — no human input required", () => {
    const r = buildWeeklyReport(input);
    expect(r.weekLabel).toBe("week 33");
    // KPI vs target percentages computed deterministically
    expect(r.kpis[0].pct).toBeCloseTo(0.84, 5);
    expect(r.kpis[2].pct).toBeNull(); // no target → no pct, still renders
    // every section is present and filled from the input alone
    expect(r.funnel[1].conversion).toBeCloseTo(0.6, 5);
    expect(r.sources.length).toBe(1);
    expect(r.auditToMeeting.rate).toBeCloseTo(0.3, 5);
    expect(r.docChain.acceptanceRate).toBe(1);
    expect(r.docChain.avgDaysToSigned).toBeCloseTo(2, 5);
    // the report object carries no required commentary/comment field
    expect(r).not.toHaveProperty("comment");
    expect(r).not.toHaveProperty("commentary");
  });
});

describe("digest model (owner vs member)", () => {
  const base = {
    todayQueueCount: 4,
    dueCallbacks: 2,
    overdueFollowups: 3,
    pipelineAdvances: 5,
    pendingApprovals: 2,
    topReferrer: { name: "Nagy Péter", revenue: 1_500_000 },
  };
  it("includes pending approvals only for owners", () => {
    expect(buildDigestModel({ ...base, isOwner: true }).sections.some((s) => s.key === "pendingApprovals")).toBe(true);
    expect(buildDigestModel({ ...base, isOwner: false }).sections.some((s) => s.key === "pendingApprovals")).toBe(false);
  });
  it("always includes the queue, callbacks, follow-ups, deltas, referrer", () => {
    const keys = buildDigestModel({ ...base, isOwner: false }).sections.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining(["todayQueue", "dueCallbacks", "overdueFollowups", "pipelineAdvances", "topReferrer"]),
    );
  });
});
