import { describe, it, expect } from "vitest";
import { auditFunnelRates, type AuditFunnel } from "../../src/modules/public-audit/funnel";
import { buildWeeklyReport, type WeeklyReportInput } from "../../src/modules/analytics/reports";

/**
 * The self-serve funnel (playbook-v4 P12/1d).
 *
 * Three of its four steps were already recorded from the day P12 shipped; the
 * number of people who ARRIVED was not, which made every rate on the page
 * unmeasurable — including the only one that says whether the inbound idea
 * works at all.
 */
const funnel = (over: Partial<AuditFunnel> = {}): AuditFunnel => ({
  visits: 100,
  auditsRun: 20,
  blocked: 3,
  emailsCaptured: 8,
  consented: 5,
  ...over,
});

describe("auditFunnelRates", () => {
  it("divides each step by the one before it, not by the top", () => {
    const r = auditFunnelRates(funnel());
    expect(r.runRate).toBeCloseTo(0.2);
    expect(r.captureRate).toBeCloseTo(0.4);
    expect(r.consentRate).toBeCloseTo(0.625);
  });

  /**
   * Null, not zero. "Nobody visited" and "everybody who visited bounced" are
   * different facts, and printing 0% for the first reads as a problem to fix.
   */
  it("returns null where the denominator is zero", () => {
    expect(auditFunnelRates(funnel({ visits: 0 })).runRate).toBeNull();
    expect(auditFunnelRates(funnel({ auditsRun: 0 })).captureRate).toBeNull();
    expect(auditFunnelRates(funnel({ emailsCaptured: 0 })).consentRate).toBeNull();
  });

  it("can report a perfect step without rounding it away", () => {
    const r = auditFunnelRates(funnel({ emailsCaptured: 8, consented: 8 }));
    expect(r.consentRate).toBe(1);
  });
});

const input = (over: Partial<WeeklyReportInput> = {}): WeeklyReportInput => ({
  weekLabel: "2026-W35",
  kpis: [],
  funnel: [],
  sources: [],
  audit: { auditedLeads: 0, auditedLeadsWithMeeting: 0 },
  quotes: [],
  ...over,
});

describe("the weekly report", () => {
  it("carries the funnel and its rates when the landing saw something", () => {
    const r = buildWeeklyReport(input({ auditFunnel: funnel() }));
    expect(r.auditFunnel).toMatchObject({ visits: 100, consented: 5 });
    expect(r.auditFunnel!.consentRate).toBeCloseTo(0.625);
  });

  /** A permanent row of zeroes is a row people learn to skip. */
  it("leaves it out entirely in a week with no activity", () => {
    expect(buildWeeklyReport(input({ auditFunnel: funnel({ visits: 0, auditsRun: 0, blocked: 0 }) })).auditFunnel).toBeNull();
    expect(buildWeeklyReport(input()).auditFunnel).toBeNull();
  });

  /**
   * A week where the guard refused submissions and accepted none is exactly
   * the week worth looking at — so `blocked` alone is enough to report.
   */
  it("reports a week that was only refusals", () => {
    const r = buildWeeklyReport(
      input({ auditFunnel: funnel({ visits: 0, auditsRun: 0, blocked: 7, emailsCaptured: 0, consented: 0 }) }),
    );
    expect(r.auditFunnel).toBeTruthy();
    expect(r.auditFunnel!.blocked).toBe(7);
    expect(r.auditFunnel!.runRate).toBeNull();
  });
});
