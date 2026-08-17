import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { recordUndo, undo, pruneUndoEntries, UNDO_WINDOW_MS } from "../../src/modules/undo/store";
import { applyStageChange } from "../../src/modules/leads/bulk-store";
import { ensurePipelines } from "../../src/modules/deals/store";
import { createDealIn, moveStageIn } from "../../src/modules/deals/mutations";

/**
 * Undo as server-side inverse operations (playbook-v2 P7/2).
 *
 * The playbook's requirement is not "a button that puts it back" — it is that
 * the undo must not be a client-side illusion and must DECLINE on a concurrent
 * edit. Both of those are what these prove.
 */
const NAMES = ["Undo Alpha", "Undo Bravo"];
const USER = "undo-user-1";
const OTHER_USER = "undo-user-2";
let wsA = "";
let wsB = "";
let companyA = "";

const TABLES = [
  "undoEntry",
  "auditLog",
  "activity",
  "task",
  "deal",
  "dealStage",
  "pipeline",
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
  companyA = (
    await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Danubia Kft" } })
  ).id;
});

const db = () => getWorkspaceClient(wsA);

async function lead(over: Record<string, unknown> = {}) {
  return prismaUnsafe.lead.create({
    data: {
      workspaceId: wsA,
      companyId: companyA,
      contactName: "Kovács Anna",
      icpScore: 4,
      ...over,
    },
  });
}

describe("the inverse", () => {
  it("puts a stage back, and audits the undo", async () => {
    const l = await lead({ stage: "RESEARCHED" });
    await db().lead.update({ where: { id: l.id }, data: { stage: "CONTACTED" } });

    const token = await recordUndo(wsA, USER, {
      kind: "lead_stage",
      label: "Moved to Contacted",
      inverse: { entity: "lead", targets: [{ id: l.id, set: { stage: "RESEARCHED" } }] },
      expected: { [l.id]: { stage: "CONTACTED" } },
    });
    expect(token).not.toBeNull();

    const res = await undo(wsA, USER, token!.id);
    expect(res).toEqual({ ok: true, restored: 1 });
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("RESEARCHED");

    const entry = await db().auditLog.findFirstOrThrow({ where: { action: "undo.applied" } });
    expect(entry.actorUserId).toBe(USER);
  });

  it("restores a date field, not the string JSON gave it back as", async () => {
    const before = new Date("2026-07-01T00:00:00.000Z");
    const l = await lead({ stage: "RESEARCHED", stageEnteredAt: before });
    await db().lead.update({
      where: { id: l.id },
      data: { stage: "CONTACTED", stageEnteredAt: new Date() },
    });

    const token = await recordUndo(wsA, USER, {
      kind: "lead_stage",
      label: "Moved",
      inverse: {
        entity: "lead",
        targets: [
          { id: l.id, set: { stage: "RESEARCHED", stageEnteredAt: before.toISOString() } },
        ],
      },
      expected: { [l.id]: { stage: "CONTACTED" } },
    });
    await undo(wsA, USER, token!.id);

    const after = await db().lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.stageEnteredAt.toISOString()).toBe(before.toISOString());
  });
});

describe("it declines rather than overwriting", () => {
  it("refuses when somebody else has changed the row since", async () => {
    const l = await lead({ stage: "RESEARCHED" });
    await db().lead.update({ where: { id: l.id }, data: { stage: "CONTACTED" } });
    const token = await recordUndo(wsA, USER, {
      kind: "lead_stage",
      label: "Moved to Contacted",
      inverse: { entity: "lead", targets: [{ id: l.id, set: { stage: "RESEARCHED" } }] },
      expected: { [l.id]: { stage: "CONTACTED" } },
    });

    // A colleague moves it on.
    await db().lead.update({ where: { id: l.id }, data: { stage: "REPLIED" } });

    const res = await undo(wsA, USER, token!.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/changed since/);
      expect(res.conflicts).toHaveLength(1);
      expect(res.conflicts![0].actual).toBe("REPLIED");
    }
    // And it did NOT write.
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("REPLIED");
  });

  it("skips a row that has since been deleted rather than refusing the whole undo", async () => {
    const keep = await lead({ stage: "CONTACTED" });
    const gone = await lead({ stage: "CONTACTED" });
    const token = await recordUndo(wsA, USER, {
      kind: "bulk_stage",
      label: "Moved 2 leads",
      inverse: {
        entity: "lead",
        targets: [
          { id: keep.id, set: { stage: "RESEARCHED" } },
          { id: gone.id, set: { stage: "RESEARCHED" } },
        ],
      },
      expected: {
        [keep.id]: { stage: "CONTACTED" },
        [gone.id]: { stage: "CONTACTED" },
      },
    });
    await db().lead.delete({ where: { id: gone.id } });

    const res = await undo(wsA, USER, token!.id);
    expect(res).toEqual({ ok: true, restored: 1 });
    expect((await db().lead.findUniqueOrThrow({ where: { id: keep.id } })).stage).toBe("RESEARCHED");
  });
});

describe("the token is a capability", () => {
  it("cannot be used by another person", async () => {
    const l = await lead({ stage: "CONTACTED" });
    const token = await recordUndo(wsA, USER, {
      kind: "lead_stage",
      label: "Moved",
      inverse: { entity: "lead", targets: [{ id: l.id, set: { stage: "RESEARCHED" } }] },
      expected: { [l.id]: { stage: "CONTACTED" } },
    });

    const res = await undo(wsA, OTHER_USER, token!.id);
    expect(res.ok).toBe(false);
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("CONTACTED");
  });

  it("cannot be used from another workspace", async () => {
    const l = await lead({ stage: "CONTACTED" });
    const token = await recordUndo(wsA, USER, {
      kind: "lead_stage",
      label: "Moved",
      inverse: { entity: "lead", targets: [{ id: l.id, set: { stage: "RESEARCHED" } }] },
      expected: { [l.id]: { stage: "CONTACTED" } },
    });
    expect((await undo(wsB, USER, token!.id)).ok).toBe(false);
  });

  it("works once, then says so", async () => {
    const l = await lead({ stage: "CONTACTED" });
    const token = await recordUndo(wsA, USER, {
      kind: "lead_stage",
      label: "Moved",
      inverse: { entity: "lead", targets: [{ id: l.id, set: { stage: "RESEARCHED" } }] },
      expected: { [l.id]: { stage: "CONTACTED" } },
    });
    expect((await undo(wsA, USER, token!.id)).ok).toBe(true);
    const second = await undo(wsA, USER, token!.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already undone/);
  });

  it("expires", async () => {
    const l = await lead({ stage: "CONTACTED" });
    const token = await recordUndo(wsA, USER, {
      kind: "lead_stage",
      label: "Moved",
      inverse: { entity: "lead", targets: [{ id: l.id, set: { stage: "RESEARCHED" } }] },
      expected: { [l.id]: { stage: "CONTACTED" } },
    });
    const late = await undo(wsA, USER, token!.id, Date.now() + UNDO_WINDOW_MS + 1000);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/Too late/);

    expect(await pruneUndoEntries(wsA, Date.now() + UNDO_WINDOW_MS + 1000)).toBe(1);
  });
});

describe("wired into the real actions", () => {
  it("a bulk stage change offers an undo for exactly the leads that moved", async () => {
    const ok1 = await lead({ stage: "RESEARCHED", icpScore: 4 });
    const ok2 = await lead({ stage: "RESEARCHED", icpScore: 5 });
    // Below the gate: it will be skipped, and must not appear in the inverse.
    const blocked = await lead({ stage: "RESEARCHED", icpScore: 1 });

    const res = await applyStageChange(
      wsA,
      USER,
      [ok1.id, ok2.id, blocked.id],
      "CONTACTED",
      3,
    );
    expect(res.applied).toBe(2);
    expect(res.undo).not.toBeNull();

    await undo(wsA, USER, res.undo!.id);
    const after = await db().lead.findMany({ orderBy: { createdAt: "asc" } });
    const byId = new Map(after.map((l) => [l.id, l.stage]));
    expect(byId.get(ok1.id)).toBe("RESEARCHED");
    expect(byId.get(ok2.id)).toBe("RESEARCHED");
    expect(byId.get(blocked.id)).toBe("RESEARCHED");
  });

  it("a deal stage move offers an undo that restores the status too", async () => {
    const [pipeline] = await ensurePipelines(wsA);
    const won = pipeline.stages.find((s) => s.kind === "won")!;
    const created = await createDealIn(wsA, USER, { title: "Rebuild", pipelineId: pipeline.id });
    if (!created.ok) throw new Error("setup failed");

    const moved = await moveStageIn(wsA, USER, created.dealId, won.id);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect((await db().deal.findUniqueOrThrow({ where: { id: created.dealId } })).status).toBe(
      "WON",
    );

    await undo(wsA, USER, moved.undo!.id);
    const back = await db().deal.findUniqueOrThrow({ where: { id: created.dealId } });
    expect(back.status).toBe("OPEN");
    expect(back.closedAt).toBeNull();
    expect(back.stageId).not.toBe(won.id);
  });
});
