import { describe, it, expect } from "vitest";
import {
  COMMISSION_RATE,
  WINDOW_MONTHS,
  computeMonthlyCommission,
  monthsRemainingInWindow,
  terminationSettlement,
  windowStartFor,
  type PaymentRecord,
} from "../../src/modules/revenue/commission";

/**
 * The BDR commission (playbook-v3 P11/1d), implemented against the employment
 * contract clause by clause. Every rule below is one the contract states:
 *
 *   1. 10% of the NET (VAT-excluded) revenue actually RECEIVED in that month.
 *   2. One-off sales: commission once, after full payment is received.
 *   3. Recurring: monthly for 12 months from the client's FIRST payment, and
 *      only months with an actual received payment produce commission.
 *   4. Refunds remove the commission for that amount and offset against future
 *      payouts.
 *   5. Termination: the remaining commission across all open windows.
 *
 * Money is integer forints throughout (CLAUDE.md), so every figure here is a
 * whole number and the rounding is stated rather than incidental.
 */

const FANNI = "user-fanni";
const TAMAS = "user-tamas";

function pay(over: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    companyId: "c1",
    companyName: "Danubia Kft",
    netAmount: 100_000,
    receivedAt: new Date("2026-03-10T00:00:00Z"),
    recurring: true,
    attributedUserId: FANNI,
    ...over,
  };
}

const run = (month: string, payments: PaymentRecord[], carryIn?: Record<string, number>) =>
  computeMonthlyCommission({ month, payments, carryIn });

describe("rule 1 — 10% of net received in the month", () => {
  it("pays a tenth of the net", () => {
    expect(COMMISSION_RATE).toBe(0.1);
    const [user] = run("2026-03", [pay({ netAmount: 250_000 })]);
    expect(user.lines[0].commission).toBe(25_000);
    expect(user.payable).toBe(25_000);
  });

  it("counts only payments received IN that month", () => {
    const payments = [
      pay({ netAmount: 100_000, receivedAt: new Date("2026-03-10") }),
      pay({ netAmount: 900_000, receivedAt: new Date("2026-04-02") }),
    ];
    expect(run("2026-03", payments)[0].payable).toBe(10_000);
    expect(run("2026-04", payments)[0].payable).toBe(90_000);
  });

  it("rounds to whole forints", () => {
    // 10% of 123 456 is 12 345.6 — money is an integer, so it rounds.
    const [user] = run("2026-03", [pay({ netAmount: 123_456 })]);
    expect(user.lines[0].commission).toBe(12_346);
    expect(Number.isInteger(user.lines[0].commission)).toBe(true);
  });

  it("produces nothing at all for a month with no payments", () => {
    expect(run("2026-05", [pay({ receivedAt: new Date("2026-03-10") })])).toEqual([]);
  });
});

describe("rule 2 — a one-off is commissioned once, on full payment", () => {
  it("commissions the one-off in the month it was received", () => {
    const [user] = run("2026-03", [pay({ recurring: false, netAmount: 800_000 })]);
    expect(user.lines[0].commission).toBe(80_000);
    expect(user.lines[0].recurring).toBe(false);
  });

  it("does not commission it again in a later month", () => {
    const payments = [pay({ recurring: false, receivedAt: new Date("2026-03-10") })];
    expect(run("2026-04", payments)).toEqual([]);
  });

  it("is NOT limited by the 12-month window", () => {
    // The window governs recurring revenue. A one-off sale two years into the
    // relationship is still a sale, and the contract commissions it.
    const payments = [
      pay({ netAmount: 50_000, receivedAt: new Date("2025-01-10") }), // opens the window
      pay({
        recurring: false,
        netAmount: 600_000,
        receivedAt: new Date("2027-06-10"), // long past the window
      }),
    ];
    const [user] = run("2027-06", payments);
    expect(user.lines[0].commission).toBe(60_000);
    expect(user.lines[0].outsideWindow).toBe(false);
  });
});

describe("rule 3 — recurring runs 12 months from the client's FIRST payment", () => {
  const first = new Date("2026-01-20T00:00:00Z");

  it("anchors the window on the earliest payment from that client", () => {
    const payments = [
      pay({ receivedAt: new Date("2026-03-10") }),
      pay({ receivedAt: first }),
      pay({ receivedAt: new Date("2026-02-10") }),
    ];
    expect(windowStartFor(payments)?.toISOString()).toBe(first.toISOString());
  });

  it("has a twelve-month window", () => {
    expect(WINDOW_MONTHS).toBe(12);
  });

  it("commissions a payment inside the window", () => {
    const payments = [pay({ receivedAt: first }), pay({ receivedAt: new Date("2026-12-05") })];
    const [user] = run("2026-12", payments);
    expect(user.lines[0].commission).toBe(10_000);
    expect(user.lines[0].outsideWindow).toBe(false);
  });

  it("stops commissioning once the window has closed", () => {
    // January 2026 opens it; January 2027 is month 13.
    const payments = [pay({ receivedAt: first }), pay({ receivedAt: new Date("2027-01-05") })];
    const [user] = run("2027-01", payments);
    expect(user.lines[0].outsideWindow).toBe(true);
    expect(user.lines[0].commission).toBe(0);
    expect(user.payable).toBe(0);
  });

  it("still SHOWS the payment outside the window, so the report is not silently short", () => {
    const payments = [pay({ receivedAt: first }), pay({ receivedAt: new Date("2027-01-05") })];
    const [user] = run("2027-01", payments);
    expect(user.lines).toHaveLength(1);
    expect(user.lines[0].receivedNet).toBe(100_000);
  });

  it("pays nothing for a month in which the client paid nothing", () => {
    // "Only months with an actual received payment produce commission" — the
    // window being open is not itself a reason to pay.
    const payments = [pay({ receivedAt: first })];
    expect(run("2026-05", payments)).toEqual([]);
  });

  it("counts the months remaining in the window", () => {
    // Window opens January. In March, two months are gone and nine remain
    // after the current one.
    const payments = [pay({ receivedAt: first }), pay({ receivedAt: new Date("2026-03-10") })];
    const [user] = run("2026-03", payments);
    expect(user.lines[0].monthsRemaining).toBe(9);
  });
});

describe("rule 4 — refunds remove commission and offset future payouts", () => {
  it("a refund in the same month nets off against the payment", () => {
    const payments = [
      pay({ netAmount: 300_000, receivedAt: new Date("2026-03-05") }),
      pay({ netAmount: -100_000, receivedAt: new Date("2026-03-20") }),
    ];
    const [user] = run("2026-03", payments);
    expect(user.grossCommission).toBe(20_000);
    expect(user.payable).toBe(20_000);
  });

  it("a refund alone makes the month negative and pays nothing", () => {
    // A refund reverses a payment that really happened, so the client's history
    // comes with it — that history is what anchors the window the reversal
    // falls inside. (A refund handed over with no history at all reverses
    // nothing, which the "outside the window" case below covers.)
    const [user] = run("2026-04", [
      pay({ netAmount: 600_000, receivedAt: new Date("2026-02-10") }),
      pay({ netAmount: -200_000, receivedAt: new Date("2026-04-10") }),
    ]);
    expect(user.grossCommission).toBe(-20_000);
    // The system never moves money, and it certainly never claws it back by
    // paying a negative amount. It carries.
    expect(user.payable).toBe(0);
    expect(user.carriedOut).toBe(-20_000);
  });

  it("the negative balance offsets the NEXT month's payout", () => {
    const [user] = run(
      "2026-05",
      [pay({ netAmount: 500_000, receivedAt: new Date("2026-05-10") })],
      { [FANNI]: -20_000 },
    );
    expect(user.grossCommission).toBe(50_000);
    expect(user.carriedIn).toBe(-20_000);
    expect(user.payable).toBe(30_000);
    expect(user.carriedOut).toBe(0);
  });

  it("carries what it cannot absorb into the month after that", () => {
    const [user] = run(
      "2026-05",
      [pay({ netAmount: 100_000, receivedAt: new Date("2026-05-10") })],
      { [FANNI]: -50_000 },
    );
    expect(user.payable).toBe(0);
    expect(user.carriedOut).toBe(-40_000);
  });

  it("a refund outside the window removes nothing, because nothing was paid", () => {
    const payments = [
      pay({ receivedAt: new Date("2026-01-20") }),
      pay({ netAmount: -100_000, receivedAt: new Date("2027-03-10") }),
    ];
    const [user] = run("2027-03", payments);
    expect(user.lines[0].outsideWindow).toBe(true);
    expect(user.grossCommission).toBe(0);
  });
});

describe("attribution", () => {
  it("splits the report per sourcing user", () => {
    const users = run("2026-03", [
      pay({ attributedUserId: FANNI, netAmount: 100_000 }),
      pay({ attributedUserId: TAMAS, companyId: "c2", netAmount: 200_000 }),
    ]);
    expect(users).toHaveLength(2);
    expect(users.find((u) => u.userId === FANNI)!.payable).toBe(10_000);
    expect(users.find((u) => u.userId === TAMAS)!.payable).toBe(20_000);
  });

  it("keeps unattributed revenue visible rather than dropping it", () => {
    // Money nobody is credited with is a question for the Owner, not something
    // to disappear from a payroll report.
    const users = run("2026-03", [pay({ attributedUserId: null })]);
    expect(users).toHaveLength(1);
    expect(users[0].userId).toBeNull();
  });

  it("gives one user a line per client, not one per payment", () => {
    const users = run("2026-03", [
      pay({ companyId: "c1", netAmount: 100_000, receivedAt: new Date("2026-03-01") }),
      pay({ companyId: "c1", netAmount: 50_000, receivedAt: new Date("2026-03-20") }),
      pay({ companyId: "c2", companyName: "Bravo", netAmount: 70_000 }),
    ]);
    expect(users[0].lines).toHaveLength(2);
    const danubia = users[0].lines.find((l) => l.companyId === "c1")!;
    expect(danubia.receivedNet).toBe(150_000);
    expect(danubia.commission).toBe(15_000);
  });

  it("sorts a user's lines by what they earned, largest first", () => {
    const [user] = run("2026-03", [
      pay({ companyId: "c1", companyName: "Small", netAmount: 10_000 }),
      pay({ companyId: "c2", companyName: "Big", netAmount: 900_000 }),
    ]);
    expect(user.lines.map((l) => l.companyName)).toEqual(["Big", "Small"]);
  });
});

describe("rule 5 — the termination lump sum", () => {
  const windows = [
    {
      companyId: "c1",
      companyName: "Danubia Kft",
      attributedUserId: FANNI,
      windowStart: new Date("2026-01-15T00:00:00Z"),
      currentMonthlyNet: 100_000,
    },
    {
      companyId: "c2",
      companyName: "Bravo Kft",
      attributedUserId: FANNI,
      windowStart: new Date("2026-06-01T00:00:00Z"),
      currentMonthlyNet: 50_000,
    },
  ];

  it("counts the months left in a window after the end date", () => {
    // Window opens January; ending in April leaves May-December: 8 months.
    expect(monthsRemainingInWindow(new Date("2026-01-15"), new Date("2026-04-30"))).toBe(8);
  });

  it("has nothing left on the last month of the window", () => {
    expect(monthsRemainingInWindow(new Date("2026-01-15"), new Date("2026-12-31"))).toBe(0);
  });

  it("never goes negative past the end of a window", () => {
    expect(monthsRemainingInWindow(new Date("2026-01-15"), new Date("2027-06-30"))).toBe(0);
  });

  it("values each window at the CURRENT monthly fee times the months left", () => {
    const settlement = terminationSettlement(windows, new Date("2026-04-30"));
    const fanni = settlement.find((s) => s.userId === FANNI)!;
    const danubia = fanni.lines.find((l) => l.companyId === "c1")!;
    expect(danubia.monthsRemaining).toBe(8);
    expect(danubia.remainingNet).toBe(800_000);
    expect(danubia.commission).toBe(80_000);
  });

  it("sums every open window per user", () => {
    const settlement = terminationSettlement(windows, new Date("2026-06-30"));
    const fanni = settlement.find((s) => s.userId === FANNI)!;
    // c1: window Jan, ending June -> 6 months left x 100k = 600k
    // c2: window June, ending June -> 11 months left x 50k = 550k
    expect(fanni.totalRemainingNet).toBe(600_000 + 550_000);
    expect(fanni.totalCommission).toBe(115_000);
  });

  it("drops a window that has already closed", () => {
    const settlement = terminationSettlement(windows, new Date("2027-08-31"));
    expect(settlement).toEqual([]);
  });

  it("reports the gross remaining revenue beside the commission", () => {
    // The contract's wording for this clause gives the formula as
    // (monthly fee x months remaining) and calls the result "the remaining
    // commission". Both numbers are reported so the settlement figure is not
    // ambiguous no matter which reading is meant.
    const settlement = terminationSettlement(windows, new Date("2026-04-30"));
    const fanni = settlement.find((s) => s.userId === FANNI)!;
    expect(fanni.totalRemainingNet).toBeGreaterThan(fanni.totalCommission);
    expect(fanni.totalCommission).toBe(Math.round(fanni.totalRemainingNet * COMMISSION_RATE));
  });
});
