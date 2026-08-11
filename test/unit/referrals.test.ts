import { describe, it, expect } from "vitest";
import {
  aggregateReferrals,
  topReferrers,
  type RefLeadFact,
} from "../../src/modules/referrals/ledger";

const facts: RefLeadFact[] = [
  // Referrer A: 3 referred — 1 won (2M), 1 lost, 1 still open
  { leadId: "l1", referrerId: "A", stage: "HANDED_OFF", result: "won", value: 2_000_000 },
  { leadId: "l2", referrerId: "A", stage: "HANDED_OFF", result: "lost", value: 0 },
  { leadId: "l3", referrerId: "A", stage: "CONTACTED", result: null, value: 0 },
  // Referrer B: 2 referred — 1 won (500k), 1 postponed
  { leadId: "l4", referrerId: "B", stage: "HANDED_OFF", result: "won", value: 500_000 },
  { leadId: "l5", referrerId: "B", stage: "MEETING_BOOKED", result: "postponed", value: 0 },
  // No referrer — must be ignored
  { leadId: "l6", referrerId: null, stage: "HANDED_OFF", result: "won", value: 9_000_000 },
];

describe("referral ledger aggregation (spec §4.18)", () => {
  it("aggregates referred / won / lost / open and attributes WON revenue per referrer", () => {
    const map = aggregateReferrals(facts);
    const a = map.get("A")!;
    expect(a.referred).toBe(3);
    expect(a.won).toBe(1);
    expect(a.lost).toBe(1);
    expect(a.open).toBe(1); // no outcome yet
    expect(a.attributedRevenue).toBe(2_000_000);

    const b = map.get("B")!;
    expect(b.referred).toBe(2);
    expect(b.won).toBe(1);
    expect(b.postponed).toBe(1);
    expect(b.open).toBe(0);
    expect(b.attributedRevenue).toBe(500_000);
  });

  it("ignores leads with no referrer (self-sourced revenue is not attributed)", () => {
    const map = aggregateReferrals(facts);
    expect(map.has("null")).toBe(false);
    const total = [...map.values()].reduce((s, r) => s + r.attributedRevenue, 0);
    expect(total).toBe(2_500_000); // excludes the 9M self-sourced win
  });

  it("ranks top referrers by attributed revenue", () => {
    const map = aggregateReferrals(facts);
    const meta = new Map([
      ["A", { name: "Ács Béla", kind: "person" as const }],
      ["B", { name: "Kovács Kft.", kind: "company" as const }],
    ]);
    const top = topReferrers(map, meta, 5);
    expect(top.map((t) => t.name)).toEqual(["Ács Béla", "Kovács Kft."]);
    expect(top[0].attributedRevenue).toBe(2_000_000);
    expect(top[0].referred).toBe(3);
    expect(top[0].won).toBe(1);
  });

  it("orders equal-revenue referrers by referral count then name", () => {
    const tie: RefLeadFact[] = [
      { leadId: "x", referrerId: "Z", stage: "HANDED_OFF", result: "won", value: 100 },
      { leadId: "y", referrerId: "Y", stage: "HANDED_OFF", result: "won", value: 100 },
      { leadId: "y2", referrerId: "Y", stage: "CONTACTED", result: null, value: 0 },
    ];
    const map = aggregateReferrals(tie);
    const meta = new Map([
      ["Z", { name: "Zed", kind: "person" as const }],
      ["Y", { name: "Yara", kind: "person" as const }],
    ]);
    const top = topReferrers(map, meta, 5);
    // Y has more referrals at equal revenue → ranks first
    expect(top.map((t) => t.name)).toEqual(["Yara", "Zed"]);
  });
});
