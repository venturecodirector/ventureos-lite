import { describe, it, expect } from "vitest";
import {
  validateOutcome,
  scoreBand,
  OUTCOME_REASONS,
} from "../../src/modules/analytics/taxonomy";
import {
  aggregate,
  buildWhatCloses,
  type OutcomeFact,
} from "../../src/modules/analytics/aggregate";

describe("outcome required on close — validateOutcome (spec §4.20)", () => {
  const base = { result: "won", reason: "price", value: 1_800_000, competitor: null, note: null };

  it("accepts a well-formed won outcome", () => {
    const r = validateOutcome(base);
    expect(r.ok).toBe(true);
  });

  it("rejects a missing/blank result", () => {
    expect(validateOutcome({ ...base, result: "" }).ok).toBe(false);
    expect(validateOutcome({ ...base, result: "maybe" }).ok).toBe(false);
  });

  it("rejects a reason outside the taxonomy", () => {
    expect(validateOutcome({ ...base, reason: "vibes" }).ok).toBe(false);
    expect(validateOutcome({ ...base, reason: "" }).ok).toBe(false);
  });

  it("requires a note when reason is 'other'", () => {
    expect(validateOutcome({ ...base, reason: "other", note: "" }).ok).toBe(false);
    expect(validateOutcome({ ...base, reason: "other", note: "internal build" }).ok).toBe(true);
  });

  it("requires an integer, non-negative HUF value", () => {
    expect(validateOutcome({ ...base, value: null }).ok).toBe(false);
    expect(validateOutcome({ ...base, value: 1200.5 }).ok).toBe(false);
    expect(validateOutcome({ ...base, value: -5 }).ok).toBe(false);
    expect(validateOutcome({ ...base, value: 0 }).ok).toBe(true);
  });

  it("normalises the taxonomy on success", () => {
    const r = validateOutcome({ ...base, reason: "competitor", competitor: " Acme ", value: 500000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.reason).toBe("competitor");
      expect(r.value.competitor).toBe("Acme");
      expect(OUTCOME_REASONS).toContain(r.value.reason);
    }
  });
});

describe("audit-score bands", () => {
  it("bands scores and handles no audit", () => {
    expect(scoreBand(null)).toBe("no_audit");
    expect(scoreBand(0)).toBe("0-49");
    expect(scoreBand(49)).toBe("0-49");
    expect(scoreBand(50)).toBe("50-69");
    expect(scoreBand(69)).toBe("50-69");
    expect(scoreBand(70)).toBe("70-84");
    expect(scoreBand(84)).toBe("70-84");
    expect(scoreBand(85)).toBe("85-100");
    expect(scoreBand(100)).toBe("85-100");
  });
});

describe("what-closes aggregation math (spec §4.20)", () => {
  const facts: OutcomeFact[] = [
    {
      result: "won",
      value: 2_000_000,
      dims: { hook: "audit-gap", signals: ["no_website"], source: "PROSPECTOR", segment: "HoReCa", scoreBand: "70-84" },
    },
    {
      result: "lost",
      value: 1_000_000,
      dims: { hook: "audit-gap", signals: ["no_website", "hiring"], source: "PROSPECTOR", segment: "HoReCa", scoreBand: "50-69" },
    },
    {
      result: "won",
      value: 500_000,
      dims: { hook: "referral", signals: ["hiring"], source: "REFERRAL", segment: "Manufacturing", scoreBand: "85-100" },
    },
    {
      result: "postponed",
      value: 300_000,
      dims: { hook: "referral", signals: [], source: "REFERRAL", segment: "Manufacturing", scoreBand: "85-100" },
    },
  ];

  it("computes close rate = won/(won+lost) and revenue = won value, per bucket", () => {
    const byHook = aggregate(facts, (f) => (f.dims.hook ? [f.dims.hook] : []));
    const auditGap = byHook.find((r) => r.key === "audit-gap")!;
    expect(auditGap.deals).toBe(2);
    expect(auditGap.won).toBe(1);
    expect(auditGap.lost).toBe(1);
    expect(auditGap.closeRate).toBeCloseTo(0.5, 5);
    expect(auditGap.revenue).toBe(2_000_000);

    const referral = byHook.find((r) => r.key === "referral")!;
    expect(referral.deals).toBe(2); // one won, one postponed
    expect(referral.postponed).toBe(1);
    expect(referral.closeRate).toBe(1); // won/(won+lost) = 1/1, postponed excluded
    expect(referral.revenue).toBe(500_000);
  });

  it("maps multi-valued signals into every matching bucket", () => {
    const bySignal = aggregate(facts, (f) => f.dims.signals);
    const noWebsite = bySignal.find((r) => r.key === "no_website")!;
    expect(noWebsite.deals).toBe(2); // appears in fact 0 (won) and fact 1 (lost)
    expect(noWebsite.won).toBe(1);
    expect(noWebsite.revenue).toBe(2_000_000);
    const hiring = bySignal.find((r) => r.key === "hiring")!;
    expect(hiring.deals).toBe(2);
    expect(hiring.won).toBe(1);
  });

  it("sorts buckets by revenue descending", () => {
    const bySource = aggregate(facts, (f) => (f.dims.source ? [f.dims.source] : []));
    expect(bySource.map((r) => r.key)).toEqual(["PROSPECTOR", "REFERRAL"]);
  });

  it("buildWhatCloses returns all five dimensions", () => {
    const w = buildWhatCloses(facts);
    expect(Object.keys(w).sort()).toEqual(
      ["byHook", "byScoreBand", "bySegment", "bySignal", "bySource"].sort(),
    );
    expect(w.byScoreBand.find((r) => r.key === "85-100")!.won).toBe(1);
  });
});
