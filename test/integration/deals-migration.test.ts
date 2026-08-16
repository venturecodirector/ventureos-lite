import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import {
  apply,
  plan,
  rollback,
  verify,
  MIGRATION_SOURCE,
} from "../../src/modules/deals/migrate";

/**
 * The P4 deals migration against a real database (playbook-v2 P4/d).
 *
 * The development database this ran against is almost entirely Playwright
 * fixtures, so the dry-run recorded in docs/migrations/p4-deals.md exercises one
 * narrow path. Every other path — grant routing, WON/LOST placement, value from
 * an outcome, value from a quote, relinking, idempotency, rollback and the
 * integrity check's failure modes — is built explicitly here.
 */
const NAMES = ["Deals Migration Alpha", "Deals Migration Bravo"];
let wsA = "";
let wsB = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  await prismaUnsafe.dealOutcome.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.subscriptionEvent.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.subscription.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.document.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});

afterAll(clean);

beforeEach(async () => {
  const ids = [wsA, wsB];
  await prismaUnsafe.dealOutcome.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.subscription.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.document.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: ids } } });
});

const db = () => getWorkspaceClient(wsA);

async function makeLead(over: {
  stage: "RESEARCHED" | "CONTACTED" | "QUALIFIED" | "MEETING_BOOKED" | "HANDED_OFF" | "NOT_NOW";
  companyName?: string;
  industry?: string;
  signals?: string[];
  ownerId?: string;
  contactName?: string;
}) {
  const company = await prismaUnsafe.company.create({
    data: {
      workspaceId: wsA,
      name: over.companyName ?? "Danubia Kft",
      industry: over.industry ?? null,
    },
  });
  return prismaUnsafe.lead.create({
    data: {
      workspaceId: wsA,
      companyId: company.id,
      contactName: over.contactName ?? "Kovács Anna",
      stage: over.stage,
      stageEnteredAt: new Date("2026-07-01T00:00:00Z"),
      signals: over.signals ?? [],
      ownerId: over.ownerId ?? null,
    },
  });
}

describe("plan", () => {
  it("accounts for every lead stage, and converts only the deal-owned ones", async () => {
    await makeLead({ stage: "RESEARCHED" });
    await makeLead({ stage: "CONTACTED" });
    await makeLead({ stage: "NOT_NOW" });
    await makeLead({ stage: "QUALIFIED" });
    await makeLead({ stage: "MEETING_BOOKED" });
    await makeLead({ stage: "HANDED_OFF" });

    const p = await plan(wsA);
    expect(Object.values(p.leadsByStage).reduce((a, b) => a + b, 0)).toBe(6);
    expect(p.deals).toHaveLength(3);
    expect(p.deals.map((d) => d.stageKey).sort()).toEqual([
      "handed_off",
      "meeting",
      "qualified",
    ]);
  });

  it("routes grant work to the Grants pipeline and everything else to web projects", async () => {
    await makeLead({ stage: "QUALIFIED", signals: ["pályázat"], companyName: "Palya Kft" });
    await makeLead({ stage: "QUALIFIED", companyName: "Webshop Kft", industry: "Retail" });

    const p = await plan(wsA);
    const byCompany = new Map(p.deals.map((d) => [d.companyName, d.pipelineKey]));
    expect(byCompany.get("Palya Kft")).toBe("grants");
    expect(byCompany.get("Webshop Kft")).toBe("web-projects");
  });

  it("takes the value from the outcome, then the quote, then zero", async () => {
    const withOutcome = await makeLead({ stage: "HANDED_OFF", companyName: "Outcome Kft" });
    await prismaUnsafe.dealOutcome.create({
      data: {
        workspaceId: wsA,
        leadId: withOutcome.id,
        result: "WON",
        value: 2_400_000,
        at: new Date("2026-07-20T00:00:00Z"),
      },
    });

    const withQuote = await makeLead({ stage: "QUALIFIED", companyName: "Quote Kft" });
    await prismaUnsafe.document.create({
      data: {
        workspaceId: wsA,
        leadId: withQuote.id,
        type: "QUOTE",
        totals: { net: 900_000, vat: 243_000, gross: 1_143_000 },
      },
    });

    await makeLead({ stage: "QUALIFIED", companyName: "Bare Kft" });

    const p = await plan(wsA);
    const byCompany = new Map(p.deals.map((d) => [d.companyName, d]));
    expect(byCompany.get("Outcome Kft")!.value).toBe(2_400_000);
    expect(byCompany.get("Outcome Kft")!.valueSource).toBe("outcome");
    expect(byCompany.get("Quote Kft")!.value).toBe(900_000);
    expect(byCompany.get("Quote Kft")!.valueSource).toBe("quote");
    expect(byCompany.get("Bare Kft")!.value).toBe(0);
    expect(byCompany.get("Bare Kft")!.valueSource).toBe("none");
  });

  it("places a closed lead in its pipeline's terminal stage, not the mapped one", async () => {
    const lost = await makeLead({ stage: "MEETING_BOOKED", companyName: "Lost Kft" });
    await prismaUnsafe.dealOutcome.create({
      data: { workspaceId: wsA, leadId: lost.id, result: "LOST", at: new Date("2026-07-10") },
    });

    const p = await plan(wsA);
    expect(p.deals[0].status).toBe("LOST");
    expect(p.deals[0].stageKey).toBe("lost");
  });

  it("treats a postponed outcome as still open", async () => {
    const lead = await makeLead({ stage: "QUALIFIED" });
    await prismaUnsafe.dealOutcome.create({
      data: { workspaceId: wsA, leadId: lead.id, result: "POSTPONED", at: new Date("2026-07-10") },
    });
    const p = await plan(wsA);
    expect(p.deals[0].status).toBe("OPEN");
    expect(p.deals[0].stageKey).toBe("qualified");
  });

  it("writes nothing — a dry-run is a read", async () => {
    await makeLead({ stage: "QUALIFIED" });
    await plan(wsA);
    expect(await db().deal.count()).toBe(0);
    expect(await db().pipeline.count()).toBe(0);
  });
});

describe("apply", () => {
  it("creates the pipelines, the deals, and relinks documents, subs and outcomes", async () => {
    const lead = await makeLead({ stage: "HANDED_OFF", ownerId: "user-1" });
    const quote = await prismaUnsafe.document.create({
      data: {
        workspaceId: wsA,
        leadId: lead.id,
        type: "QUOTE",
        totals: { net: 500_000, vat: 135_000, gross: 635_000 },
      },
    });
    await prismaUnsafe.document.create({
      data: { workspaceId: wsA, leadId: lead.id, type: "CONTRACT", chainParentId: quote.id },
    });
    await prismaUnsafe.subscription.create({
      data: {
        workspaceId: wsA,
        companyId: lead.companyId!,
        leadId: lead.id,
        planName: "Hosting",
        monthlyNet: 50_000,
        startDate: new Date("2026-06-01"),
      },
    });
    await prismaUnsafe.dealOutcome.create({
      data: { workspaceId: wsA, leadId: lead.id, result: "WON", value: 500_000 },
    });

    const res = await apply(wsA);
    expect(res.pipelinesCreated).toBe(2);
    expect(res.dealsCreated).toBe(1);
    expect(res.documentsLinked).toBe(2);
    expect(res.subscriptionsLinked).toBe(1);
    expect(res.outcomesLinked).toBe(1);

    const deal = await db().deal.findFirstOrThrow();
    expect(deal.source).toBe(MIGRATION_SOURCE);
    expect(deal.ownerId).toBe("user-1");
    expect(deal.value).toBe(500_000);
    expect(deal.status).toBe("WON");
    // Copied from the lead, so the rotting clock does not restart at migration.
    expect(deal.stageEnteredAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("leaves Lead.stage exactly where it was — the layer is additive", async () => {
    const lead = await makeLead({ stage: "MEETING_BOOKED" });
    await apply(wsA);
    const after = await db().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stage).toBe("MEETING_BOOKED");
  });

  it("is idempotent: a second run creates nothing", async () => {
    await makeLead({ stage: "QUALIFIED" });
    await apply(wsA);
    const second = await apply(wsA);
    expect(second.dealsCreated).toBe(0);
    expect(second.pipelinesCreated).toBe(0);
    expect(await db().deal.count()).toBe(1);
  });

  it("does not reach into another workspace", async () => {
    await makeLead({ stage: "QUALIFIED" });
    const otherCompany = await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Bravo Kft" },
    });
    await prismaUnsafe.lead.create({
      data: {
        workspaceId: wsB,
        companyId: otherCompany.id,
        contactName: "Other",
        stage: "QUALIFIED",
      },
    });

    await apply(wsA);
    expect(await prismaUnsafe.deal.count({ where: { workspaceId: wsB } })).toBe(0);
    expect(await prismaUnsafe.pipeline.count({ where: { workspaceId: wsB } })).toBe(0);
  });
});

describe("verify", () => {
  it("passes on a clean migration", async () => {
    await makeLead({ stage: "QUALIFIED" });
    await makeLead({ stage: "MEETING_BOOKED" });
    await apply(wsA);

    const report = await verify(wsA);
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails when a deal-owned lead was left without a deal", async () => {
    await makeLead({ stage: "QUALIFIED" });
    await apply(wsA);
    // Someone moved a lead into a deal-owned stage after the migration ran.
    await makeLead({ stage: "HANDED_OFF", companyName: "Latecomer Kft" });

    const report = await verify(wsA);
    expect(report.ok).toBe(false);
    expect(report.issues[0].check).toBe("every deal-owned lead has a deal");
  });

  it("fails when a document chain straddles two deals", async () => {
    const lead = await makeLead({ stage: "QUALIFIED" });
    const quote = await prismaUnsafe.document.create({
      data: { workspaceId: wsA, leadId: lead.id, type: "QUOTE" },
    });
    await prismaUnsafe.document.create({
      data: { workspaceId: wsA, leadId: lead.id, type: "CONTRACT", chainParentId: quote.id },
    });
    await apply(wsA);
    expect((await verify(wsA)).ok).toBe(true);

    // Break it deliberately: the child now claims no deal at all.
    await prismaUnsafe.document.updateMany({
      where: { workspaceId: wsA, type: "CONTRACT" },
      data: { dealId: null },
    });
    const broken = await verify(wsA);
    expect(broken.ok).toBe(false);
    expect(broken.issues.map((i) => i.check)).toContain("document chains intact");
  });
});

describe("rollback", () => {
  it("removes exactly what apply created and restores the prior state", async () => {
    const lead = await makeLead({ stage: "HANDED_OFF" });
    const doc = await prismaUnsafe.document.create({
      data: { workspaceId: wsA, leadId: lead.id, type: "QUOTE" },
    });
    await prismaUnsafe.dealOutcome.create({
      data: { workspaceId: wsA, leadId: lead.id, result: "WON", value: 100_000 },
    });
    await apply(wsA);

    const res = await rollback(wsA);
    expect(res.dealsDeleted).toBe(1);
    expect(res.documentsUnlinked).toBe(1);
    expect(res.outcomesUnlinked).toBe(1);

    expect(await db().deal.count()).toBe(0);
    expect((await db().document.findUniqueOrThrow({ where: { id: doc.id } })).dealId).toBeNull();
    // The lead never moved, so there is nothing to restore.
    expect((await db().lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("HANDED_OFF");
    // Pipelines are configuration and stay.
    expect(await db().pipeline.count()).toBe(2);
  });

  it("spares a deal a person created by hand", async () => {
    await makeLead({ stage: "QUALIFIED" });
    await apply(wsA);
    const pipeline = await db().pipeline.findFirstOrThrow({
      where: { key: "web-projects" },
      include: { stages: true },
    });
    await db().deal.create({
      data: {
        workspaceId: wsA,
        title: "Hand-made deal",
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0].id,
        value: 1,
      },
    });

    await rollback(wsA);
    const left = await db().deal.findMany();
    expect(left).toHaveLength(1);
    expect(left[0].title).toBe("Hand-made deal");
  });

  it("is safe to run when there is nothing to undo", async () => {
    const res = await rollback(wsA);
    expect(res.dealsDeleted).toBe(0);
  });
});
