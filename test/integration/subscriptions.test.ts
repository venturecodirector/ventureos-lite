import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import {
  createSubscription,
  changeSubscriptionAmount,
  changeSubscriptionStatus,
  markInvoicePaid,
  markInvoiceRefunded,
  promoteToClient,
} from "../../src/modules/revenue/store";

/**
 * The recurring book against the real database (playbook-v3 P11/1a).
 *
 * The invariant everything downstream rests on: the signed deltas in the
 * append-only event log sum to what the subscription contributes today.
 */
const NAMES = ["Revenue Alpha", "Revenue Bravo"];
let wsA = "";
let wsB = "";
let companyA = "";
let companyB = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    await prismaUnsafe.subscriptionEvent.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.invoice.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.subscription.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});

afterAll(async () => {
  await clean();
});

beforeEach(async () => {
  await prismaUnsafe.subscriptionEvent.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prismaUnsafe.invoice.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prismaUnsafe.subscription.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  companyA = (
    await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Danubia Kft" } })
  ).id;
  companyB = (
    await prismaUnsafe.company.create({ data: { workspaceId: wsB, name: "Bravo Kft" } })
  ).id;
});

const db = () => getWorkspaceClient(wsA);

async function newSub(monthlyNet = 100_000) {
  const res = await createSubscription(wsA, {
    companyId: companyA,
    planName: "Hosting + retainer",
    monthlyNet,
    startDate: new Date("2026-01-15T00:00:00Z"),
    source: "retainer",
  });
  if (!res.ok) throw new Error(res.error);
  return res.subscription;
}

async function events(subscriptionId: string) {
  return prismaUnsafe.subscriptionEvent.findMany({
    where: { subscriptionId },
    orderBy: { at: "asc" },
  });
}

describe("creating a subscription", () => {
  it("writes a `new` event carrying the full amount", async () => {
    const sub = await newSub(120_000);
    const log = await events(sub.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "new", deltaNet: 120_000, monthlyNetAfter: 120_000 });
  });

  it("promotes the company to client, dated from the subscription start", async () => {
    const sub = await newSub();
    const company = await prismaUnsafe.company.findUnique({ where: { id: companyA } });
    expect(company?.clientStatus).toBe("CLIENT");
    expect(company?.clientSince?.toISOString()).toBe(sub.startDate.toISOString());
  });

  it("does not move an earlier clientSince later", async () => {
    // Already a client since November. A second subscription starting the
    // following January must not reset the tenure — client age feeds the health
    // score, and a resetting date keeps long-standing clients looking new.
    await promoteToClient(wsA, companyA, new Date("2025-11-01T00:00:00Z"));
    await newSub(); // starts 2026-01-15
    const company = await prismaUnsafe.company.findUnique({ where: { id: companyA } });
    expect(company?.clientSince?.toISOString()).toBe("2025-11-01T00:00:00.000Z");
  });

  it("does pull clientSince back when an EARLIER engagement is recorded", async () => {
    // Backfilling an older subscription should correct the tenure downward.
    await promoteToClient(wsA, companyA, new Date("2026-06-01T00:00:00Z"));
    await newSub(); // starts 2026-01-15
    const company = await prismaUnsafe.company.findUnique({ where: { id: companyA } });
    expect(company?.clientSince?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("refuses a source outside the taxonomy", async () => {
    const res = await createSubscription(wsA, {
      companyId: companyA,
      planName: "x",
      monthlyNet: 1,
      startDate: new Date(),
      source: "carrier-pigeon",
    });
    expect(res.ok).toBe(false);
  });

  it("refuses a company from another workspace", async () => {
    const res = await createSubscription(wsA, {
      companyId: companyB,
      planName: "x",
      monthlyNet: 1,
      startDate: new Date(),
      source: "hosting",
    });
    expect(res.ok).toBe(false);
  });

  it("refuses a billing day February cannot have", async () => {
    const res = await createSubscription(wsA, {
      companyId: companyA,
      planName: "x",
      monthlyNet: 1,
      startDate: new Date(),
      source: "hosting",
      billingDay: 31,
    });
    expect(res.ok).toBe(false);
  });
});

describe("changing the amount", () => {
  it("appends expansion and leaves the original row alone", async () => {
    const sub = await newSub(100_000);
    await changeSubscriptionAmount(wsA, sub.id, 150_000);
    const log = await events(sub.id);
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ kind: "expansion", deltaNet: 50_000 });
    // Append-only: the `new` row still says what it always said.
    expect(log[0]).toMatchObject({ kind: "new", deltaNet: 100_000 });
  });

  it("appends contraction with a negative delta", async () => {
    const sub = await newSub(100_000);
    await changeSubscriptionAmount(wsA, sub.id, 70_000);
    expect((await events(sub.id))[1]).toMatchObject({ kind: "contraction", deltaNet: -30_000 });
  });

  it("writes nothing when the amount does not move", async () => {
    const sub = await newSub(100_000);
    await changeSubscriptionAmount(wsA, sub.id, 100_000);
    expect(await events(sub.id)).toHaveLength(1);
  });
});

describe("changing the status", () => {
  it("churn removes the amount and records the reason on the event", async () => {
    const sub = await newSub(90_000);
    await changeSubscriptionStatus(wsA, sub.id, "CHURNED", "price");
    const log = await events(sub.id);
    expect(log[1]).toMatchObject({ kind: "churn", deltaNet: -90_000, reason: "price" });
    const row = await prismaUnsafe.subscription.findUnique({ where: { id: sub.id } });
    expect(row?.status).toBe("CHURNED");
    expect(row?.churnReason).toBe("price");
    expect(row?.churnedAt).not.toBeNull();
  });

  it("refuses to churn without a reason from the taxonomy", async () => {
    const sub = await newSub();
    expect((await changeSubscriptionStatus(wsA, sub.id, "CHURNED")).ok).toBe(false);
    expect((await changeSubscriptionStatus(wsA, sub.id, "CHURNED", "because")).ok).toBe(false);
    const row = await prismaUnsafe.subscription.findUnique({ where: { id: sub.id } });
    expect(row?.status).toBe("ACTIVE");
  });

  it("marks the company FORMER once its last subscription churns", async () => {
    const sub = await newSub();
    await changeSubscriptionStatus(wsA, sub.id, "CHURNED", "project_ended");
    const company = await prismaUnsafe.company.findUnique({ where: { id: companyA } });
    expect(company?.clientStatus).toBe("FORMER");
  });

  it("keeps the company a CLIENT while any subscription survives", async () => {
    const first = await newSub();
    await newSub(50_000);
    await changeSubscriptionStatus(wsA, first.id, "CHURNED", "price");
    const company = await prismaUnsafe.company.findUnique({ where: { id: companyA } });
    expect(company?.clientStatus).toBe("CLIENT");
  });

  it("reactivating a churned subscription makes the company a CLIENT again", async () => {
    const sub = await newSub();
    await changeSubscriptionStatus(wsA, sub.id, "CHURNED", "budget_cut");
    await changeSubscriptionStatus(wsA, sub.id, "ACTIVE");
    const company = await prismaUnsafe.company.findUnique({ where: { id: companyA } });
    expect(company?.clientStatus).toBe("CLIENT");
    expect((await events(sub.id))[2]).toMatchObject({ kind: "reactivation" });
  });
});

describe("the deltas reconcile with reality", () => {
  it("summing the log gives what the subscription contributes today", async () => {
    const sub = await newSub(100_000);
    await changeSubscriptionAmount(wsA, sub.id, 150_000);
    await changeSubscriptionStatus(wsA, sub.id, "PAUSED");
    await changeSubscriptionStatus(wsA, sub.id, "ACTIVE");

    const log = await events(sub.id);
    const summed = log.reduce((n, e) => n + e.deltaNet, 0);
    const row = await prismaUnsafe.subscription.findUnique({ where: { id: sub.id } });
    expect(summed).toBe(150_000);
    expect(row?.monthlyNet).toBe(150_000);
    expect(row?.status).toBe("ACTIVE");
  });

  it("and zero once it has churned", async () => {
    const sub = await newSub(100_000);
    await changeSubscriptionAmount(wsA, sub.id, 150_000);
    await changeSubscriptionStatus(wsA, sub.id, "CHURNED", "competitor");
    const log = await events(sub.id);
    expect(log.reduce((n, e) => n + e.deltaNet, 0)).toBe(0);
  });
});

describe("the payment ledger", () => {
  async function invoice(net: number) {
    return db().invoice.create({
      data: { workspaceId: wsA, companyId: companyA, netAmount: net, status: "ISSUED" },
    });
  }

  it("marking paid stamps when the money arrived", async () => {
    const inv = await invoice(500_000);
    const at = new Date("2026-04-03T10:00:00Z");
    await markInvoicePaid(wsA, inv.id, at);
    const row = await prismaUnsafe.invoice.findUnique({ where: { id: inv.id } });
    expect(row?.status).toBe("PAID");
    expect(row?.paidAt?.toISOString()).toBe(at.toISOString());
  });

  it("paying an invoice promotes the company to client too", async () => {
    const inv = await invoice(500_000);
    await markInvoicePaid(wsA, inv.id, new Date("2026-04-03T10:00:00Z"));
    const company = await prismaUnsafe.company.findUnique({ where: { id: companyA } });
    expect(company?.clientStatus).toBe("CLIENT");
  });

  it("does not re-stamp an invoice that was already paid", async () => {
    const inv = await invoice(500_000);
    const first = new Date("2026-04-03T10:00:00Z");
    await markInvoicePaid(wsA, inv.id, first);
    await markInvoicePaid(wsA, inv.id, new Date("2026-05-03T10:00:00Z"));
    const row = await prismaUnsafe.invoice.findUnique({ where: { id: inv.id } });
    // The commission run keys off this date; moving it would move a payment
    // into a different month after the fact.
    expect(row?.paidAt?.toISOString()).toBe(first.toISOString());
  });

  it("a refund keeps the row and records what went back out", async () => {
    const inv = await invoice(500_000);
    await markInvoicePaid(wsA, inv.id, new Date("2026-04-03T10:00:00Z"));
    await markInvoiceRefunded(wsA, inv.id, 500_000, new Date("2026-05-10T10:00:00Z"));
    const row = await prismaUnsafe.invoice.findUnique({ where: { id: inv.id } });
    expect(row?.status).toBe("REFUNDED");
    expect(row?.refundedNet).toBe(500_000);
    // paidAt survives: the money DID arrive, and the ledger has to show both legs.
    expect(row?.paidAt).not.toBeNull();
  });

  it("refuses to refund more than was received", async () => {
    const inv = await invoice(500_000);
    await markInvoicePaid(wsA, inv.id, new Date("2026-04-03T10:00:00Z"));
    const res = await markInvoiceRefunded(wsA, inv.id, 600_000, new Date());
    expect(res.ok).toBe(false);
  });

  it("refuses to refund something never paid", async () => {
    const inv = await invoice(500_000);
    expect((await markInvoiceRefunded(wsA, inv.id, 100, new Date())).ok).toBe(false);
  });
});

describe("tenancy", () => {
  it("cannot change a subscription from another workspace", async () => {
    const sub = await newSub();
    const res = await changeSubscriptionAmount(wsB, sub.id, 1);
    expect(res.ok).toBe(false);
    const row = await prismaUnsafe.subscription.findUnique({ where: { id: sub.id } });
    expect(row?.monthlyNet).toBe(100_000);
  });
});
