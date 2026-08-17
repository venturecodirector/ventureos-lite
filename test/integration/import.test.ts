import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import {
  listImportBatches,
  listImportTemplates,
  rollbackImport,
  runImport,
  saveImportTemplate,
  validateImport,
} from "../../src/modules/import/store";
import { createFieldDef } from "../../src/modules/fields/store";
import { ensurePipelines } from "../../src/modules/deals/store";

/**
 * CSV import v2 against the real database (playbook-v2 P5/3).
 *
 * The interesting half is the rollback: it has to remove what the import
 * created, revert what it updated, and REFUSE — naming names — when a person
 * has touched a row since. A rollback that quietly discards someone's
 * correction is a second import, not an undo.
 */
const NAMES = ["Import Alpha", "Import Bravo"];
let wsA = "";
let wsB = "";

const TABLES = [
  "importBatch",
  "importTemplate",
  "auditLog",
  "activity",
  "call",
  "document",
  "deal",
  "dealStage",
  "pipeline",
  "customFieldDef",
  "lead",
  "company",
] as const;

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of TABLES) {
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
  for (const t of TABLES) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  }
});

const db = () => getWorkspaceClient(wsA);

const ROWS = [
  { contactName: "Kovács Anna", email: "anna@danubia.hu", companyName: "Danubia Kft" },
  { contactName: "Szabó Péter", email: "peter@alfa.hu", companyName: "Alfa Kft" },
];

describe("running an import", () => {
  it("creates leads and companies, tagged with the batch", async () => {
    const res = await runImport(wsA, "user-1", { candidates: ROWS, filename: "list.csv" });
    expect(res.created).toBe(2);

    const leads = await db().lead.findMany();
    expect(leads).toHaveLength(2);
    expect(leads.every((l) => l.importBatchId === res.batchId)).toBe(true);
    expect(await db().company.count()).toBe(2);

    const [batch] = await listImportBatches(wsA);
    expect(batch.filename).toBe("list.csv");
    expect(batch.created).toBe(2);
    expect(batch.canRollback).toBe(true);
  });

  it("skips a row the operator ticked off", async () => {
    const res = await runImport(wsA, null, { candidates: ROWS, skipIndexes: [1] });
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it("leaves an existing lead alone in skip mode, and fills its gaps in update mode", async () => {
    await runImport(wsA, null, { candidates: [ROWS[0]] });

    const skipRun = await runImport(wsA, null, {
      candidates: [{ ...ROWS[0], title: "CEO" }],
      mode: "skip",
    });
    expect(skipRun.created).toBe(0);
    expect(skipRun.updated).toBe(0);
    expect((await db().lead.findFirstOrThrow()).title).toBeNull();

    const updateRun = await runImport(wsA, null, {
      candidates: [{ ...ROWS[0], title: "CEO" }],
      mode: "update",
    });
    expect(updateRun.updated).toBe(1);
    expect((await db().lead.findFirstOrThrow()).title).toBe("CEO");
  });

  it("never blanks a field an export left empty", async () => {
    await runImport(wsA, null, { candidates: [{ ...ROWS[0], title: "CEO" }] });
    await runImport(wsA, null, {
      candidates: [{ ...ROWS[0], title: "" }],
      mode: "update",
    });
    expect((await db().lead.findFirstOrThrow()).title).toBe("CEO");
  });

  it("imports validated custom-field values", async () => {
    const created = await createFieldDef(wsA, null, {
      entity: "lead",
      label: "Segment",
      type: "SELECT",
      options: [
        { value: "horeca", label: "HoReCa" },
        { value: "retail", label: "Retail" },
      ],
    });
    if (!created.ok) throw new Error(created.error);

    const summary = await validateImport(wsA, [
      { ...ROWS[0], customFields: { segment: "horeca" } },
      { ...ROWS[1], customFields: { segment: "aerospace" } },
    ]);
    expect(summary.rows[1].problems[0].code).toBe("custom_field");

    const res = await runImport(wsA, null, {
      candidates: [{ ...ROWS[0], customFields: { segment: "horeca" } }],
    });
    expect(res.created).toBe(1);
    expect((await db().lead.findFirstOrThrow()).customFields).toEqual({ segment: "horeca" });
  });

  it("never reaches another workspace", async () => {
    await runImport(wsA, null, { candidates: ROWS });
    expect(await prismaUnsafe.lead.count({ where: { workspaceId: wsB } })).toBe(0);
  });
});

describe("rolling back", () => {
  it("deletes what it created, including the companies it made", async () => {
    const res = await runImport(wsA, null, { candidates: ROWS });
    const back = await rollbackImport(wsA, "user-1", res.batchId);
    expect(back.ok).toBe(true);
    expect(await db().lead.count()).toBe(0);
    expect(await db().company.count()).toBe(0);

    const [batch] = await listImportBatches(wsA);
    expect(batch.status).toBe("rolled_back");
    expect(batch.canRollback).toBe(false);
  });

  it("reverts an update to its pre-import values", async () => {
    await runImport(wsA, null, { candidates: [ROWS[0]] });
    const before = await db().lead.findFirstOrThrow();
    expect(before.title).toBeNull();

    const second = await runImport(wsA, null, {
      candidates: [{ ...ROWS[0], title: "CEO" }],
      mode: "update",
    });
    expect((await db().lead.findFirstOrThrow()).title).toBe("CEO");

    const back = await rollbackImport(wsA, null, second.batchId);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.reverted).toBe(1);
    expect((await db().lead.findFirstOrThrow()).title).toBeNull();
  });

  it("refuses, and names the rows, when an update was edited by hand since", async () => {
    await runImport(wsA, null, { candidates: [ROWS[0]] });
    const second = await runImport(wsA, null, {
      candidates: [{ ...ROWS[0], title: "CEO" }],
      mode: "update",
    });

    const lead = await db().lead.findFirstOrThrow();
    await db().lead.update({ where: { id: lead.id }, data: { title: "Managing director" } });

    const back = await rollbackImport(wsA, null, second.batchId);
    expect(back.ok).toBe(false);
    if (!back.ok) {
      expect(back.conflicts).toHaveLength(1);
      expect(back.conflicts![0].label).toBe("Kovács Anna");
      expect(back.conflicts![0].reason).toMatch(/edited by hand/);
    }
    // Nothing was touched: a refused rollback is a no-op, not a partial one.
    expect((await db().lead.findFirstOrThrow()).title).toBe("Managing director");
  });

  it("refuses when a created lead has been worked since", async () => {
    const res = await runImport(wsA, null, { candidates: [ROWS[0]] });
    const lead = await db().lead.findFirstOrThrow();
    await prismaUnsafe.activity.create({
      data: { workspaceId: wsA, leadId: lead.id, type: "note" },
    });

    const back = await rollbackImport(wsA, null, res.batchId);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.conflicts![0].reason).toMatch(/worked since/);
    expect(await db().lead.count()).toBe(1);
  });

  it("refuses when a created lead has a deal on it", async () => {
    const res = await runImport(wsA, null, { candidates: [ROWS[0]] });
    const lead = await db().lead.findFirstOrThrow();
    const [pipeline] = await ensurePipelines(wsA);
    await db().deal.create({
      data: {
        workspaceId: wsA,
        leadId: lead.id,
        title: "Rebuild",
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0].id,
      },
    });

    const back = await rollbackImport(wsA, null, res.batchId);
    expect(back.ok).toBe(false);
    expect(await db().lead.count()).toBe(1);
  });

  it("refuses when a created lead has been researched or moved on", async () => {
    const res = await runImport(wsA, null, { candidates: [ROWS[0]] });
    const lead = await db().lead.findFirstOrThrow();
    await db().lead.update({ where: { id: lead.id }, data: { icpScore: 4 } });

    const back = await rollbackImport(wsA, null, res.batchId);
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.conflicts![0].reason).toMatch(/researched or moved/);
  });

  it("keeps a company another lead still points at", async () => {
    const res = await runImport(wsA, null, { candidates: [ROWS[0]] });
    const company = await db().company.findFirstOrThrow();
    // Somebody added a second lead at that company by hand.
    await db().lead.create({
      data: { workspaceId: wsA, companyId: company.id, contactName: "Later" },
    });

    const back = await rollbackImport(wsA, null, res.batchId);
    expect(back.ok).toBe(true);
    expect(await db().company.count()).toBe(1);
    expect(await db().lead.count()).toBe(1);
  });

  it("refuses a second rollback and one past the window", async () => {
    const res = await runImport(wsA, null, { candidates: [ROWS[0]] });
    expect((await rollbackImport(wsA, null, res.batchId)).ok).toBe(true);
    const second = await rollbackImport(wsA, null, res.batchId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already been rolled back/);

    const again = await runImport(wsA, null, { candidates: [ROWS[1]] });
    const late = await rollbackImport(
      wsA,
      null,
      again.batchId,
      new Date(Date.now() + 10 * 86_400_000),
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/window/);
  });

  it("rolls back a hundred rows cleanly", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      contactName: `Lead ${i}`,
      email: `lead${i}@bulk.test`,
      companyName: `Bulk ${i} Kft`,
    }));
    const res = await runImport(wsA, null, { candidates: many });
    expect(res.created).toBe(100);

    const back = await rollbackImport(wsA, null, res.batchId);
    expect(back.ok).toBe(true);
    expect(await db().lead.count()).toBe(0);
    expect(await db().company.count()).toBe(0);
  });
});

describe("mapping templates", () => {
  it("saves, lists and updates a mapping by name", async () => {
    const first = await saveImportTemplate(wsA, "user-1", {
      name: "Bisnode export",
      source: "bisnode",
      mapping: { contactName: 0, email: 2 },
    });
    expect(first.ok).toBe(true);

    const second = await saveImportTemplate(wsA, "user-1", {
      name: "Bisnode export",
      mapping: { contactName: 1, email: 3 },
    });
    expect(second.ok).toBe(true);

    const templates = await listImportTemplates(wsA);
    // Re-saving under the same name updates rather than making a second one.
    expect(templates).toHaveLength(1);
    expect(templates[0].mapping).toEqual({ contactName: 1, email: 3 });
    expect(templates[0].source).toBe("bisnode");
  });

  it("does not leak a template into another workspace", async () => {
    await saveImportTemplate(wsA, null, { name: "Mine", mapping: { email: 0 } });
    expect(await listImportTemplates(wsB)).toEqual([]);
  });
});
