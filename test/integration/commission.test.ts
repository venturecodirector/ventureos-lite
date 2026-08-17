import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { ensurePipelines } from "../../src/modules/deals/store";
import {
  buildCommissionReport,
  buildSettlementReport,
  loadPaymentLedger,
} from "../../src/modules/revenue/commission-data";

/**
 * Commission end to end from the real ledger (playbook-v3 P11/1d).
 *
 * The arithmetic is unit-tested; what matters here is that real invoices become
 * the right payment records, that attribution follows the lead chain, and that
 * carried balances replay correctly across months.
 */
const NAMES = ["Commission Alpha", "Commission Bravo"];
const EMAILS = ["comm-fanni@iso.test", "comm-tamas@iso.test"];

let wsA = "";
let wsB = "";
let fanni = "";
let tamas = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of [
      "invoice",
      "subscriptionEvent",
      "subscription",
      "activity",
      "deal",
      "dealStage",
      "pipeline",
      "lead",
      "company",
    ] as const) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
  const mk = async (email: string, name: string) =>
    (await prismaUnsafe.user.create({ data: { email, name, passwordHash: "x" } })).id;
  fanni = await mk(EMAILS[0], "Fanni");
  tamas = await mk(EMAILS[1], "Tamas");
  await prismaUnsafe.membership.create({ data: { userId: fanni, workspaceId: wsA, role: "BDR" } });
  await prismaUnsafe.membership.create({ data: { userId: tamas, workspaceId: wsA, role: "OWNER" } });
});

afterAll(async () => {
  await clean();
});

beforeEach(async () => {
  for (const t of [
    "invoice",
    "subscriptionEvent",
    "subscription",
    "activity",
    "deal",
    "dealStage",
    "pipeline",
    "lead",
    "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  }
});

const db = () => getWorkspaceClient(wsA);

/** A client with a lead owned by `ownerId`, plus an active subscription. */
async function client(name: string, ownerId: string | null, monthlyNet = 100_000) {
  const company = await db().company.create({
    data: { workspaceId: wsA, name, clientStatus: "CLIENT" },
  });
  await db().lead.create({
    data: { workspaceId: wsA, companyId: company.id, contactName: `${name} contact`, ownerId },
  });
  const sub = await db().subscription.create({
    data: {
      workspaceId: wsA,
      companyId: company.id,
      planName: "Retainer",
      monthlyNet,
      startDate: new Date("2026-01-01"),
      source: "retainer",
    },
  });
  return { companyId: company.id, subscriptionId: sub.id };
}

async function paid(
  companyId: string,
  netAmount: number,
  paidAt: string,
  subscriptionId: string | null,
) {
  return db().invoice.create({
    data: {
      workspaceId: wsA,
      companyId,
      subscriptionId,
      netAmount,
      status: "PAID",
      paidAt: new Date(paidAt),
    },
  });
}

describe("the ledger", () => {
  it("turns a paid invoice into a payment record with its company and attribution", async () => {
    const c = await client("Danubia Kft", fanni);
    await paid(c.companyId, 250_000, "2026-03-10", c.subscriptionId);

    const ledger = await loadPaymentLedger(wsA);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      companyId: c.companyId,
      companyName: "Danubia Kft",
      netAmount: 250_000,
      recurring: true,
      attributedUserId: fanni,
    });
  });

  it("marks an invoice with no subscription as a one-off", async () => {
    const c = await client("Danubia Kft", fanni);
    await paid(c.companyId, 800_000, "2026-03-10", null);
    const ledger = await loadPaymentLedger(wsA);
    expect(ledger[0].recurring).toBe(false);
  });

  it("ignores an invoice that was never paid", async () => {
    const c = await client("Danubia Kft", fanni);
    await db().invoice.create({
      data: { workspaceId: wsA, companyId: c.companyId, netAmount: 100_000, status: "ISSUED" },
    });
    expect(await loadPaymentLedger(wsA)).toEqual([]);
  });

  it("adds a refund as a negative record dated when the money went back", async () => {
    const c = await client("Danubia Kft", fanni);
    const inv = await paid(c.companyId, 500_000, "2026-03-10", c.subscriptionId);
    await db().invoice.update({
      where: { id: inv.id },
      data: { status: "REFUNDED", refundedNet: 200_000, refundedAt: new Date("2026-05-04") },
    });

    const ledger = await loadPaymentLedger(wsA);
    expect(ledger).toHaveLength(2);
    const refund = ledger.find((r) => r.netAmount < 0)!;
    expect(refund.netAmount).toBe(-200_000);
    expect(refund.receivedAt.toISOString().slice(0, 7)).toBe("2026-05");
  });

  it("never reads another workspace's invoices", async () => {
    const other = await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Bravo Kft" },
    });
    await prismaUnsafe.invoice.create({
      data: {
        workspaceId: wsB,
        companyId: other.id,
        netAmount: 999_999,
        status: "PAID",
        paidAt: new Date("2026-03-10"),
      },
    });
    expect(await loadPaymentLedger(wsA)).toEqual([]);
  });
});

describe("attribution follows the lead chain", () => {
  it("credits the lead owner", async () => {
    const c = await client("Danubia Kft", tamas);
    await paid(c.companyId, 100_000, "2026-03-10", c.subscriptionId);
    const report = await buildCommissionReport(wsA, "2026-03");
    expect(report.users[0].userId).toBe(tamas);
  });

  it("falls back to whoever first worked the lead when nobody owns it", async () => {
    const c = await client("Danubia Kft", null);
    const lead = await db().lead.findFirst({ where: { companyId: c.companyId } });
    await db().activity.create({
      data: {
        workspaceId: wsA,
        leadId: lead!.id,
        type: "note",
        byUserId: fanni,
        at: new Date("2026-01-05"),
      },
    });
    await paid(c.companyId, 100_000, "2026-03-10", c.subscriptionId);

    const report = await buildCommissionReport(wsA, "2026-03");
    expect(report.users[0].userId).toBe(fanni);
  });

  it("keeps revenue nobody is credited with visible as unattributed", async () => {
    const c = await client("Danubia Kft", null);
    await paid(c.companyId, 100_000, "2026-03-10", c.subscriptionId);
    const report = await buildCommissionReport(wsA, "2026-03");
    expect(report.users).toHaveLength(1);
    expect(report.users[0].userId).toBeNull();
    expect(report.totalPayable).toBe(10_000);
  });

  it("carries the referrer through as context, without attributing to them", async () => {
    const c = await client("Danubia Kft", fanni);
    const referrer = await db().referrer.create({
      data: { workspaceId: wsA, kind: "PERSON", name: "Kovács Béla" },
    });
    await db().lead.updateMany({
      where: { companyId: c.companyId },
      data: { referrerId: referrer.id },
    });
    await paid(c.companyId, 100_000, "2026-03-10", c.subscriptionId);

    const report = await buildCommissionReport(wsA, "2026-03");
    expect(report.referrers[c.companyId]).toBe("Kovács Béla");
    // Still the lead OWNER who is paid — a referrer is not a user.
    expect(report.users[0].userId).toBe(fanni);
  });
});

describe("attribution prefers the deal that closed (v2 P4)", () => {
  async function dealFor(companyId: string, ownerId: string, status: "OPEN" | "WON") {
    const [pipeline] = await ensurePipelines(wsA);
    const stage =
      status === "WON"
        ? pipeline.stages.find((s) => s.kind === "won")!
        : pipeline.stages.find((s) => s.kind === "open")!;
    return db().deal.create({
      data: {
        workspaceId: wsA,
        companyId,
        title: "Rebuild",
        pipelineId: pipeline.id,
        stageId: stage.id,
        ownerId,
        status,
        closedAt: status === "WON" ? new Date("2026-02-01") : null,
      },
    });
  }

  it("credits whoever closed the deal, over the lead's owner", async () => {
    const c = await client("Danubia Kft", tamas);
    await dealFor(c.companyId, fanni, "WON");
    await paid(c.companyId, 100_000, "2026-03-10", c.subscriptionId);

    const report = await buildCommissionReport(wsA, "2026-03");
    expect(report.users[0].userId).toBe(fanni);
  });

  it("falls back to the lead owner for a client that predates the deals layer", async () => {
    const c = await client("Danubia Kft", tamas);
    await paid(c.companyId, 100_000, "2026-03-10", c.subscriptionId);

    const report = await buildCommissionReport(wsA, "2026-03");
    expect(report.users[0].userId).toBe(tamas);
  });

  it("credits a deal owner even when the client has no lead at all", async () => {
    const company = await db().company.create({
      data: { workspaceId: wsA, name: "Leadless Kft", clientStatus: "CLIENT" },
    });
    await dealFor(company.id, fanni, "WON");
    await paid(company.id, 100_000, "2026-03-10", null);

    const report = await buildCommissionReport(wsA, "2026-03");
    expect(report.users[0].userId).toBe(fanni);
  });
});

describe("the monthly run", () => {
  it("pays 10% of what actually arrived that month", async () => {
    const c = await client("Danubia Kft", fanni);
    await paid(c.companyId, 300_000, "2026-03-10", c.subscriptionId);
    await paid(c.companyId, 900_000, "2026-04-10", c.subscriptionId);

    expect((await buildCommissionReport(wsA, "2026-03")).totalPayable).toBe(30_000);
    expect((await buildCommissionReport(wsA, "2026-04")).totalPayable).toBe(90_000);
  });

  it("replays carried balances across months without storing them", async () => {
    const c = await client("Danubia Kft", fanni);
    const inv = await paid(c.companyId, 600_000, "2026-02-10", c.subscriptionId);
    // A refund in April bigger than April's receipts.
    await db().invoice.update({
      where: { id: inv.id },
      data: { status: "REFUNDED", refundedNet: 500_000, refundedAt: new Date("2026-04-04") },
    });
    await paid(c.companyId, 100_000, "2026-05-10", c.subscriptionId);

    const april = await buildCommissionReport(wsA, "2026-04");
    expect(april.users[0].payable).toBe(0);
    expect(april.users[0].carriedOut).toBe(-50_000);

    // May receives 100k -> 10k commission, still less than the carried -50k.
    const may = await buildCommissionReport(wsA, "2026-05");
    expect(may.users[0].carriedIn).toBe(-50_000);
    expect(may.users[0].payable).toBe(0);
    expect(may.users[0].carriedOut).toBe(-40_000);
  });

  it("stops paying recurring revenue once the 12-month window closes", async () => {
    const c = await client("Danubia Kft", fanni);
    await paid(c.companyId, 100_000, "2026-01-10", c.subscriptionId); // opens the window
    await paid(c.companyId, 100_000, "2027-02-10", c.subscriptionId); // month 14

    const report = await buildCommissionReport(wsA, "2027-02");
    expect(report.totalPayable).toBe(0);
    expect(report.users[0].lines[0].outsideWindow).toBe(true);
    // Still visible, so the report is not silently short.
    expect(report.users[0].lines[0].receivedNet).toBe(100_000);
  });
});

describe("the termination settlement", () => {
  it("values each open window at the live fee times the months left", async () => {
    const c = await client("Danubia Kft", fanni, 100_000);
    await paid(c.companyId, 100_000, "2026-01-15", c.subscriptionId);

    const settlement = await buildSettlementReport(wsA, new Date("2026-04-30"));
    const line = settlement.users[0].lines[0];
    expect(line.monthsRemaining).toBe(8);
    expect(line.remainingNet).toBe(800_000);
    expect(line.commission).toBe(80_000);
  });

  it("ignores a client who has never paid — no window has opened", async () => {
    await client("Never Paid Kft", fanni);
    const settlement = await buildSettlementReport(wsA, new Date("2026-04-30"));
    expect(settlement.users).toEqual([]);
  });

  it("ignores a churned subscription — there is no current fee to multiply", async () => {
    const c = await client("Danubia Kft", fanni);
    await paid(c.companyId, 100_000, "2026-01-15", c.subscriptionId);
    await db().subscription.update({
      where: { id: c.subscriptionId },
      data: { status: "CHURNED", churnedAt: new Date("2026-03-01"), churnReason: "price" },
    });

    const settlement = await buildSettlementReport(wsA, new Date("2026-04-30"));
    expect(settlement.users).toEqual([]);
  });

  it("reports revenue and commission side by side", async () => {
    const c = await client("Danubia Kft", fanni, 100_000);
    await paid(c.companyId, 100_000, "2026-01-15", c.subscriptionId);
    const settlement = await buildSettlementReport(wsA, new Date("2026-04-30"));
    expect(settlement.totalRemainingNet).toBe(800_000);
    expect(settlement.totalCommission).toBe(80_000);
  });
});

describe("churn ends the accrual (P11/1e)", () => {
  it("stops commission once the invoices stop, without touching what was already earned", async () => {
    const c = await client("Danubia Kft", fanni, 100_000);
    await paid(c.companyId, 100_000, "2026-01-10", c.subscriptionId);
    await paid(c.companyId, 100_000, "2026-02-10", c.subscriptionId);

    // Churn in March. Commission is driven by PAYMENTS RECEIVED, so the two
    // months already paid keep their commission and March simply has none.
    await db().subscription.update({
      where: { id: c.subscriptionId },
      data: { status: "CHURNED", churnedAt: new Date("2026-03-01"), churnReason: "price" },
    });

    expect((await buildCommissionReport(wsA, "2026-01")).totalPayable).toBe(10_000);
    expect((await buildCommissionReport(wsA, "2026-02")).totalPayable).toBe(10_000);
    expect((await buildCommissionReport(wsA, "2026-03")).users).toEqual([]);
  });

  it("still commissions a payment that lands AFTER the churn", async () => {
    // A final invoice settled a month late is money actually received, and the
    // contract commissions what is received — churning does not cancel it.
    const c = await client("Danubia Kft", fanni, 100_000);
    await paid(c.companyId, 100_000, "2026-01-10", c.subscriptionId);
    await db().subscription.update({
      where: { id: c.subscriptionId },
      data: { status: "CHURNED", churnedAt: new Date("2026-02-01"), churnReason: "price" },
    });
    await paid(c.companyId, 100_000, "2026-03-05", c.subscriptionId);

    expect((await buildCommissionReport(wsA, "2026-03")).totalPayable).toBe(10_000);
  });

  it("removes the client from the termination settlement", async () => {
    const c = await client("Danubia Kft", fanni, 100_000);
    await paid(c.companyId, 100_000, "2026-01-15", c.subscriptionId);
    expect((await buildSettlementReport(wsA, new Date("2026-04-30"))).users).toHaveLength(1);

    await db().subscription.update({
      where: { id: c.subscriptionId },
      data: { status: "CHURNED", churnedAt: new Date("2026-02-01"), churnReason: "price" },
    });
    // Nothing remains to settle: there is no current monthly fee to multiply.
    expect((await buildSettlementReport(wsA, new Date("2026-04-30"))).users).toEqual([]);
  });
});
