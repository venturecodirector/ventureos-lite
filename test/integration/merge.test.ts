import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import {
  listDuplicateCandidates,
  listMergeHistory,
  mergeRecords,
  previewMerge,
  resolveSurvivor,
  revertMerge,
} from "../../src/modules/merge/store";
import { ensurePipelines } from "../../src/modules/deals/store";
import { clearCache } from "../../src/lib/ttl-cache";

/**
 * Merging against the real database (playbook-v2 P5/2).
 *
 * The detection rules are unit-tested. What matters here is what a merge MOVES,
 * that the loser survives as a tombstone whose id still resolves, and that the
 * undo puts back exactly what the merge took — and nothing attached since.
 */
const NAMES = ["Merge Alpha", "Merge Bravo"];
let wsA = "";
let wsB = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of [
    "mergeRecord",
    "auditLog",
    "activity",
    "call",
    "document",
    "dealOutcome",
    "task",
    "deal",
    "dealStage",
    "pipeline",
    "subscription",
    "lead",
    "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});

afterAll(clean);

beforeEach(async () => {
  // The duplicate scan and the table facets are cached in-process for 60s
  // (P6/3). A test rewrites the database underneath that, so it starts cold.
  clearCache();
  const ids = [wsA, wsB];
  for (const t of [
    "mergeRecord",
    "activity",
    "call",
    "document",
    "dealOutcome",
    "task",
    "deal",
    "dealStage",
    "pipeline",
    "subscription",
    "lead",
    "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
});

const db = () => getWorkspaceClient(wsA);

async function company(name: string, over: Record<string, unknown> = {}) {
  return prismaUnsafe.company.create({ data: { workspaceId: wsA, name, ...over } });
}

async function lead(name: string, companyId: string | null, over: Record<string, unknown> = {}) {
  return prismaUnsafe.lead.create({
    data: { workspaceId: wsA, contactName: name, companyId, ...over },
  });
}

describe("candidates", () => {
  it("surfaces a shared tax id from the real table", async () => {
    await company("Danubia Kft", { taxId: "12345678-1-42" });
    await company("Danubia Korlátolt", { taxId: "12345678142" });
    const { companies } = await listDuplicateCandidates(wsA);
    expect(companies).toHaveLength(1);
    expect(companies[0].reason).toBe("tax_id");
  });

  it("never crosses into another workspace", async () => {
    await company("Danubia Kft", { taxId: "1" });
    await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Danubia Kft", taxId: "1" },
    });
    const { companies } = await listDuplicateCandidates(wsA);
    expect(companies).toEqual([]);
  });
});

describe("preview", () => {
  it("suggests the newer value where both sides have one, and the filled one otherwise", async () => {
    const older = await company("Danubia Kft", {
      phone: "+3611111111",
      city: "Budapest",
      createdAt: new Date("2025-01-01"),
    });
    const newer = await company("Danubia Kft.", {
      phone: "+3622222222",
      createdAt: new Date("2026-06-01"),
    });

    const res = await previewMerge(wsA, "company", older.id, newer.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byField = new Map(res.preview.fields.map((f) => [f.field, f]));
    // Both have a phone; the newer record's wins.
    expect(byField.get("phone")!.suggested).toBe("loser");
    // Only the survivor has a city.
    expect(byField.get("city")!.suggested).toBe("survivor");
  });

  it("refuses a record that has already been merged", async () => {
    const a = await company("A");
    const b = await company("B");
    await mergeRecords(wsA, null, { entity: "company", survivorId: a.id, loserId: b.id });
    const res = await previewMerge(wsA, "company", a.id, b.id);
    expect(res.ok).toBe(false);
  });
});

describe("merging companies", () => {
  it("moves the leads, deals and subscriptions, and tombstones the loser", async () => {
    const survivor = await company("Danubia Kft", { createdAt: new Date("2025-01-01") });
    const loser = await company("Danubia Kft.", {
      taxId: "12345678142",
      phone: "+3622222222",
      createdAt: new Date("2026-06-01"),
    });
    await lead("Anna", loser.id);
    await prismaUnsafe.subscription.create({
      data: {
        workspaceId: wsA,
        companyId: loser.id,
        planName: "Hosting",
        monthlyNet: 50_000,
        startDate: new Date("2026-01-01"),
      },
    });
    const [pipeline] = await ensurePipelines(wsA);
    await db().deal.create({
      data: {
        workspaceId: wsA,
        companyId: loser.id,
        title: "Rebuild",
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0].id,
      },
    });

    const res = await mergeRecords(wsA, "user-1", {
      entity: "company",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.moved.lead).toBe(1);
    expect(res.moved.deal).toBe(1);
    expect(res.moved.subscription).toBe(1);

    const after = await db().company.findUniqueOrThrow({ where: { id: survivor.id } });
    // The loser's tax id and phone came across.
    expect(after.taxId).toBe("12345678142");
    expect(after.phone).toBe("+3622222222");

    const tombstone = await db().company.findUniqueOrThrow({ where: { id: loser.id } });
    expect(tombstone.mergedIntoId).toBe(survivor.id);
    // The tombstone gave up the unique keys the survivor now holds.
    expect(tombstone.taxId).toBeNull();

    expect(await db().lead.count({ where: { companyId: survivor.id } })).toBe(1);
    expect(await db().deal.count({ where: { companyId: survivor.id } })).toBe(1);
  });

  it("resolves a tombstoned id to the survivor, through a chain", async () => {
    const c = await company("C");
    const b = await company("B");
    const a = await company("A");
    await mergeRecords(wsA, null, { entity: "company", survivorId: b.id, loserId: a.id });
    await mergeRecords(wsA, null, { entity: "company", survivorId: c.id, loserId: b.id });

    expect(await resolveSurvivor(wsA, "company", a.id)).toBe(c.id);
    expect(await resolveSurvivor(wsA, "company", c.id)).toBe(c.id);
  });
});

describe("merging leads", () => {
  it("re-links activities, calls, documents, tasks and deals", async () => {
    const co = await company("Danubia Kft");
    const survivor = await lead("Kovács Anna", co.id, { createdAt: new Date("2025-01-01") });
    const loser = await lead("Kovacs Anna", co.id, {
      email: "anna@danubia.hu",
      createdAt: new Date("2026-06-01"),
    });

    await prismaUnsafe.activity.create({
      data: { workspaceId: wsA, leadId: loser.id, type: "note" },
    });
    await prismaUnsafe.call.create({
      data: { workspaceId: wsA, leadId: loser.id, outcome: "INTERESTED" },
    });
    await prismaUnsafe.document.create({
      data: { workspaceId: wsA, leadId: loser.id, type: "QUOTE" },
    });
    await prismaUnsafe.task.create({
      data: { workspaceId: wsA, title: "Call back", entityType: "lead", entityId: loser.id },
    });
    const [pipeline] = await ensurePipelines(wsA);
    await db().deal.create({
      data: {
        workspaceId: wsA,
        leadId: loser.id,
        title: "Rebuild",
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0].id,
      },
    });

    const res = await mergeRecords(wsA, "user-1", {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.moved).toMatchObject({ activity: 1, call: 1, document: 1, task: 1, deal: 1 });

    const after = await db().lead.findUniqueOrThrow({ where: { id: survivor.id } });
    // The email only the loser had came across.
    expect(after.email).toBe("anna@danubia.hu");
    expect(await db().activity.count({ where: { leadId: survivor.id } })).toBe(1);
    expect(
      await db().task.count({ where: { entityType: "lead", entityId: survivor.id } }),
    ).toBe(1);
  });

  it("honours an explicit field choice over the default", async () => {
    const co = await company("Danubia Kft");
    const survivor = await lead("Kovács Anna", co.id, {
      phone: "+3611111111",
      createdAt: new Date("2025-01-01"),
    });
    const loser = await lead("Kovacs Anna", co.id, {
      phone: "+3622222222",
      createdAt: new Date("2026-06-01"),
    });

    await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
      // The default would take the newer phone; the person says otherwise.
      choices: { phone: "survivor" },
    });
    const after = await db().lead.findUniqueOrThrow({ where: { id: survivor.id } });
    expect(after.phone).toBe("+3611111111");
  });

  it("unions the custom-field values, survivor winning a clash", async () => {
    const co = await company("Danubia Kft");
    const survivor = await lead("A", co.id, { customFields: { a: "keep", shared: "mine" } });
    const loser = await lead("B", co.id, { customFields: { b: "gain", shared: "theirs" } });

    await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    const after = await db().lead.findUniqueOrThrow({ where: { id: survivor.id } });
    expect(after.customFields).toEqual({ a: "keep", b: "gain", shared: "mine" });
  });

  it("cannot merge across workspaces", async () => {
    const co = await company("Danubia Kft");
    const mine = await lead("Mine", co.id);
    const theirCompany = await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Theirs" },
    });
    const theirs = await prismaUnsafe.lead.create({
      data: { workspaceId: wsB, companyId: theirCompany.id, contactName: "Theirs" },
    });

    const res = await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: mine.id,
      loserId: theirs.id,
    });
    expect(res.ok).toBe(false);
    const after = await prismaUnsafe.lead.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(after.mergedIntoId).toBeNull();
  });
});

describe("undo", () => {
  it("puts back exactly what the merge moved, and restores the survivor's fields", async () => {
    const co = await company("Danubia Kft");
    const survivor = await lead("Kovács Anna", co.id, {
      phone: "+3611111111",
      createdAt: new Date("2025-01-01"),
    });
    const loser = await lead("Kovacs Anna", co.id, {
      phone: "+3622222222",
      email: "anna@danubia.hu",
      createdAt: new Date("2026-06-01"),
    });
    const activity = await prismaUnsafe.activity.create({
      data: { workspaceId: wsA, leadId: loser.id, type: "note" },
    });

    const merged = await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    if (!merged.ok) throw new Error("setup failed");

    const res = await revertMerge(wsA, "user-1", merged.mergeId);
    expect(res.ok).toBe(true);

    const back = await db().activity.findUniqueOrThrow({ where: { id: activity.id } });
    expect(back.leadId).toBe(loser.id);

    const survivorAfter = await db().lead.findUniqueOrThrow({ where: { id: survivor.id } });
    expect(survivorAfter.phone).toBe("+3611111111");
    expect(survivorAfter.email).toBeNull();

    const loserAfter = await db().lead.findUniqueOrThrow({ where: { id: loser.id } });
    expect(loserAfter.mergedIntoId).toBeNull();
  });

  it("leaves alone what was attached to the survivor after the merge", async () => {
    const co = await company("Danubia Kft");
    const survivor = await lead("A", co.id);
    const loser = await lead("B", co.id);
    await prismaUnsafe.activity.create({
      data: { workspaceId: wsA, leadId: loser.id, type: "moved" },
    });

    const merged = await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    if (!merged.ok) throw new Error("setup failed");

    // Logged AFTER the merge: it belongs to the survivor.
    const later = await prismaUnsafe.activity.create({
      data: { workspaceId: wsA, leadId: survivor.id, type: "logged after" },
    });

    await revertMerge(wsA, null, merged.mergeId);
    const stillThere = await db().activity.findUniqueOrThrow({ where: { id: later.id } });
    expect(stillThere.leadId).toBe(survivor.id);
  });

  it("restores a company's unique tax id without colliding", async () => {
    const survivor = await company("A", { createdAt: new Date("2025-01-01") });
    const loser = await company("B", { taxId: "12345678142", createdAt: new Date("2026-01-01") });

    const merged = await mergeRecords(wsA, null, {
      entity: "company",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    if (!merged.ok) throw new Error("setup failed");
    expect((await db().company.findUniqueOrThrow({ where: { id: survivor.id } })).taxId).toBe(
      "12345678142",
    );

    const res = await revertMerge(wsA, null, merged.mergeId);
    expect(res.ok).toBe(true);
    expect((await db().company.findUniqueOrThrow({ where: { id: survivor.id } })).taxId).toBeNull();
    expect((await db().company.findUniqueOrThrow({ where: { id: loser.id } })).taxId).toBe(
      "12345678142",
    );
  });

  it("refuses a second undo, and one past the window", async () => {
    const co = await company("Danubia Kft");
    const survivor = await lead("A", co.id);
    const loser = await lead("B", co.id);
    const merged = await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    if (!merged.ok) throw new Error("setup failed");

    expect((await revertMerge(wsA, null, merged.mergeId)).ok).toBe(true);
    const second = await revertMerge(wsA, null, merged.mergeId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already been undone/);

    // A fresh merge, judged from a date past the 30-day window.
    const again = await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
    });
    if (!again.ok) throw new Error("setup failed");
    const late = await revertMerge(
      wsA,
      null,
      again.mergeId,
      new Date(Date.now() + 40 * 86_400_000),
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/window/);
  });

  it("lists history with the window state", async () => {
    const co = await company("Danubia Kft");
    const survivor = await lead("Kovács Anna", co.id);
    const loser = await lead("Kovacs Anna", co.id);
    await mergeRecords(wsA, null, {
      entity: "lead",
      survivorId: survivor.id,
      loserId: loser.id,
    });

    const history = await listMergeHistory(wsA);
    expect(history).toHaveLength(1);
    expect(history[0].survivorLabel).toBe("Kovács Anna");
    expect(history[0].loserLabel).toBe("Kovacs Anna");
    expect(history[0].canRevert).toBe(true);
  });
});
