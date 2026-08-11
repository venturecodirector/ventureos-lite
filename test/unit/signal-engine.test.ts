import { describe, it, expect } from "vitest";
import {
  MIN_PROPOSAL_N,
  isEligible,
  filterEligibleProposals,
  aggregateWeek,
  proposalEffect,
  type ProposalDraft,
  type WeekFact,
} from "../../src/modules/signal/logic";

describe("n-threshold gating (spec §4.13 — min n=20)", () => {
  it("the threshold is 20", () => {
    expect(MIN_PROPOSAL_N).toBe(20);
  });

  it("gates individual n values at the boundary", () => {
    expect(isEligible(19)).toBe(false);
    expect(isEligible(20)).toBe(true);
    expect(isEligible(27)).toBe(true);
    expect(isEligible(0)).toBe(false);
  });

  it("drops under-powered proposals, keeps well-evidenced ones", () => {
    const drafts: ProposalDraft[] = [
      { kind: "FRAME_PROMOTION", title: "Promote Frame B (mfg)", evidence: "reply 19% vs 9%", n: 42, data: { frameId: "f1" } },
      { kind: "SCORE_WEIGHT", title: "Weight up 'hiring' signal", evidence: "close 3x", n: 12, data: { criterion: "trigger_signal", weight: 2 } },
      { kind: "FRAME_PROMOTION", title: "Promote Frame C", evidence: "accept 40%", n: 20, data: { frameId: "f3" } },
    ];
    const kept = filterEligibleProposals(drafts);
    expect(kept.map((d) => d.n)).toEqual([42, 20]);
    expect(kept.find((d) => d.n === 12)).toBeUndefined();
  });
});

describe("approval-only mutation (spec §4.13 — nothing self-modifies)", () => {
  it("rejecting produces NO mutation for either kind", () => {
    expect(proposalEffect("FRAME_PROMOTION", { frameId: "f1" }, "reject", { currentFrameVersion: 3 })).toBeNull();
    expect(proposalEffect("SCORE_WEIGHT", { criterion: "trigger_signal", weight: 2 }, "reject", {})).toBeNull();
  });

  it("approving a frame promotion versions the frame and marks it approved", () => {
    const m = proposalEffect("FRAME_PROMOTION", { frameId: "f1" }, "approve", { currentFrameVersion: 3 });
    expect(m).toEqual({ type: "frame", frameId: "f1", version: 4, status: "APPROVED" });
  });

  it("approving a score-weight change yields the weight mutation", () => {
    const m = proposalEffect("SCORE_WEIGHT", { criterion: "trigger_signal", weight: 2 }, "approve", {});
    expect(m).toEqual({ type: "weight", criterion: "trigger_signal", weight: 2 });
  });

  it("defaults a missing frame version to 1 → 2 on approval", () => {
    const m = proposalEffect("FRAME_PROMOTION", { frameId: "fx" }, "approve", {});
    expect(m).toMatchObject({ version: 2 });
  });
});

describe("weekly aggregation feeds the Sonnet call", () => {
  const facts: WeekFact[] = [
    { dims: ["frame:B", "segment:HoReCa"], sent: 1, accepted: 1, replied: 1, won: 1, lost: 0, revenue: 2_000_000 },
    { dims: ["frame:B", "segment:HoReCa"], sent: 1, accepted: 1, replied: 0, won: 0, lost: 1, revenue: 0 },
    { dims: ["frame:A", "segment:Mfg"], sent: 1, accepted: 0, replied: 0, won: 0, lost: 0, revenue: 0 },
  ];

  it("counts sample size (n) and derives rates per dimension", () => {
    const stats = aggregateWeek(facts);
    const b = stats.find((s) => s.key === "frame:B")!;
    expect(b.n).toBe(2); // two touches
    expect(b.sent).toBe(2);
    expect(b.accepted).toBe(2);
    expect(b.acceptRate).toBeCloseTo(1, 5);
    expect(b.replyRate).toBeCloseTo(0.5, 5); // 1 replied / 2 sent
    expect(b.closeRate).toBeCloseTo(0.5, 5); // 1 won / (1 won + 1 lost)
    expect(b.revenue).toBe(2_000_000);

    const a = stats.find((s) => s.key === "frame:A")!;
    expect(a.acceptRate).toBe(0);
    expect(a.closeRate).toBe(0); // no closed deals → guarded, not NaN
  });

  it("is sorted by sample size descending for stable prompting", () => {
    const stats = aggregateWeek(facts);
    expect(stats[0].n).toBeGreaterThanOrEqual(stats[stats.length - 1].n);
  });
});
