import { describe, it, expect } from "vitest";
import {
  buildMovement,
  monthRange,
  summarizeBook,
  churnBreakdown,
  type MovementEvent,
} from "../../src/modules/revenue/mrr";

/**
 * The MRR maths (playbook-v3 P11/1b).
 *
 * Everything is derived from the append-only event log, so the movement chart
 * is exact rather than reconstructed. The property that matters: for any month,
 * the buckets sum to the net change, and the running total tracks the real book.
 */

function ev(month: string, kind: MovementEvent["kind"], deltaNet: number): MovementEvent {
  return { kind, deltaNet, at: new Date(`${month}-15T12:00:00Z`) };
}

describe("month ranges", () => {
  it("lists contiguous months inclusive of both ends", () => {
    expect(monthRange(new Date("2026-01-10"), new Date("2026-04-02"))).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(monthRange(new Date("2025-11-01"), new Date("2026-02-01"))).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("returns the single month when both ends are in it", () => {
    expect(monthRange(new Date("2026-03-02"), new Date("2026-03-28"))).toEqual(["2026-03"]);
  });
});

describe("the movement chart", () => {
  const events = [
    ev("2026-01", "new", 100_000),
    ev("2026-02", "new", 50_000),
    ev("2026-02", "expansion", 20_000),
    ev("2026-03", "contraction", -30_000),
    ev("2026-04", "churn", -50_000),
  ];

  it("buckets each month and runs the total forward", () => {
    const rows = buildMovement(events, monthRange(new Date("2026-01-01"), new Date("2026-04-01")));
    expect(rows.map((r) => r.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(rows[0]).toMatchObject({ new: 100_000, net: 100_000, endingMrr: 100_000 });
    expect(rows[1]).toMatchObject({ new: 50_000, expansion: 20_000, net: 70_000, endingMrr: 170_000 });
    expect(rows[2]).toMatchObject({ contraction: -30_000, net: -30_000, endingMrr: 140_000 });
    expect(rows[3]).toMatchObject({ churn: -50_000, net: -50_000, endingMrr: 90_000 });
  });

  it("shows a churn as NEGATIVE MRR in the month it happened", () => {
    // The clause the P11 VERIFICATION block names explicitly.
    const rows = buildMovement(events, monthRange(new Date("2026-01-01"), new Date("2026-04-01")));
    const april = rows.find((r) => r.month === "2026-04")!;
    expect(april.churn).toBe(-50_000);
    expect(april.net).toBeLessThan(0);
    expect(april.endingMrr).toBe(90_000);
  });

  it("includes a month in which nothing happened, so the chart has no holes", () => {
    const rows = buildMovement(
      [ev("2026-01", "new", 100_000), ev("2026-04", "churn", -100_000)],
      monthRange(new Date("2026-01-01"), new Date("2026-04-01")),
    );
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ month: "2026-02", net: 0, endingMrr: 100_000 });
    expect(rows[2]).toMatchObject({ month: "2026-03", net: 0, endingMrr: 100_000 });
  });

  it("carries MRR that started BEFORE the window into the opening balance", () => {
    // Otherwise a chart of the last six months claims the book started at zero
    // six months ago.
    const rows = buildMovement(
      [ev("2025-06", "new", 200_000), ev("2026-02", "expansion", 30_000)],
      monthRange(new Date("2026-01-01"), new Date("2026-03-01")),
    );
    expect(rows[0]).toMatchObject({ month: "2026-01", net: 0, endingMrr: 200_000 });
    expect(rows[1]).toMatchObject({ month: "2026-02", expansion: 30_000, endingMrr: 230_000 });
  });

  it("folds a pause into churn and a resume into reactivation", () => {
    // The playbook names four buckets. A pause takes MRR off the book exactly
    // as a churn does, and a resume puts it back exactly as a reactivation
    // does — so they render in the bucket that describes what happened to the
    // money, rather than adding two more the reader has to interpret.
    const rows = buildMovement(
      [ev("2026-01", "new", 100_000), ev("2026-02", "pause", -100_000), ev("2026-03", "resume", 100_000)],
      monthRange(new Date("2026-01-01"), new Date("2026-03-01")),
    );
    expect(rows[1].churn).toBe(-100_000);
    expect(rows[2].reactivation).toBe(100_000);
  });

  it("keeps every bucket summing to the net", () => {
    const rows = buildMovement(events, monthRange(new Date("2026-01-01"), new Date("2026-04-01")));
    for (const row of rows) {
      const summed =
        row.new + row.expansion + row.contraction + row.churn + row.reactivation;
      expect(summed, row.month).toBe(row.net);
    }
  });

  it("ends at the same MRR the deltas add up to", () => {
    const rows = buildMovement(events, monthRange(new Date("2026-01-01"), new Date("2026-04-01")));
    const total = events.reduce((n, e) => n + e.deltaNet, 0);
    expect(rows[rows.length - 1].endingMrr).toBe(total);
  });
});

describe("the headline numbers", () => {
  const book = [
    { monthlyNet: 100_000, status: "ACTIVE" as const, companyId: "c1" },
    { monthlyNet: 50_000, status: "ACTIVE" as const, companyId: "c1" },
    { monthlyNet: 80_000, status: "ACTIVE" as const, companyId: "c2" },
    { monthlyNet: 60_000, status: "PAUSED" as const, companyId: "c3" },
    { monthlyNet: 40_000, status: "CHURNED" as const, companyId: "c4" },
  ];

  it("counts only ACTIVE subscriptions towards MRR", () => {
    // A paused subscription bills nothing this month; counting it would report
    // revenue that is not going to arrive.
    expect(summarizeBook(book).mrr).toBe(230_000);
  });

  it("derives ARR from MRR", () => {
    expect(summarizeBook(book).arr).toBe(230_000 * 12);
  });

  it("counts CLIENTS, not subscriptions", () => {
    // c1 has two subscriptions and is one client.
    expect(summarizeBook(book).clientCount).toBe(2);
  });

  it("averages revenue per client, rounded to whole forints", () => {
    expect(summarizeBook(book).averagePerClient).toBe(115_000);
  });

  it("reports zeros rather than dividing by nothing on an empty book", () => {
    expect(summarizeBook([])).toEqual({
      mrr: 0,
      arr: 0,
      clientCount: 0,
      averagePerClient: 0,
      activeCount: 0,
      pausedCount: 0,
      churnedCount: 0,
    });
  });

  it("counts each status for the table filters", () => {
    const s = summarizeBook(book);
    expect(s.activeCount).toBe(3);
    expect(s.pausedCount).toBe(1);
    expect(s.churnedCount).toBe(1);
  });
});

describe("the churn breakdown", () => {
  it("counts reasons and the MRR each took with it, worst first", () => {
    const rows = churnBreakdown([
      { reason: "price", deltaNet: -100_000 },
      { reason: "price", deltaNet: -50_000 },
      { reason: "went_quiet", deltaNet: -200_000 },
      { reason: null, deltaNet: -10_000 },
    ]);
    expect(rows[0]).toEqual({ reason: "went_quiet", count: 1, lostMrr: 200_000 });
    expect(rows[1]).toEqual({ reason: "price", count: 2, lostMrr: 150_000 });
    // A churn with no reason still has to appear, or the totals stop adding up.
    expect(rows[2]).toEqual({ reason: "unknown", count: 1, lostMrr: 10_000 });
  });

  it("is empty when nothing churned", () => {
    expect(churnBreakdown([])).toEqual([]);
  });
});
