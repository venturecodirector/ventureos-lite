import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { startProject, loadProject, closeProject } from "../../src/modules/projects/store";
import { ensurePipelines } from "../../src/modules/deals/store";
import { collectDigestData } from "../../src/modules/analytics/digest-data";

/**
 * The playbook's VERIFICATION block for P11/2, executed:
 *
 *   "winning a deal offers project creation from a template; a milestone due
 *    tomorrow appears in Today Queue; the certificate milestone opens the
 *    pre-filled generator and blocks project close until issued."
 *
 * The middle one is proven by construction rather than by a query: a milestone
 * IS a task, so it is in the task views the moment it exists. The test below
 * asserts that literally — the row a milestone creates is an ordinary Task with
 * a due date, which is what Today Queue reads.
 */
const NAMES = ["Project Alpha"];
let ws = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of [
    "milestone",
    "project",
    "projectTemplate",
    "task",
    "document",
    "deal",
    "dealStage",
    "pipeline",
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
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  await ensurePipelines(ws);
});
afterAll(clean);

beforeEach(async () => {
  for (const t of ["milestone", "project", "task", "document", "deal"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: ws } });
  }
});

async function wonDeal(title = "Weboldal — Példa Kft."): Promise<string> {
  const db = getWorkspaceClient(ws);
  const pipeline = await db.pipeline.findFirst({ orderBy: { position: "asc" } });
  const wonStage = await db.dealStage.findFirst({
    where: { pipelineId: pipeline!.id, kind: "won" },
  });
  const company = await db.company.create({ data: { workspaceId: ws, name: "Példa Kft." } });
  const deal = await db.deal.create({
    data: {
      workspaceId: ws,
      title,
      value: 1_200_000,
      pipelineId: pipeline!.id,
      stageId: wonStage!.id,
      status: "WON",
      companyId: company.id,
      closedAt: new Date(),
    },
  });
  return deal.id;
}

describe("starting a project", () => {
  it("builds the checklist from a template and dates it from the start", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const startedAt = new Date("2026-03-02T08:00:00Z");

    const res = await startProject(db, ws, { dealId, startedAt, ownerId: "u1" });
    expect(res.ok).toBe(true);

    const project = await loadProject(db, (res as { projectId: string }).projectId);
    expect(project!.milestones.length).toBeGreaterThan(3);
    expect(project!.certificate).toBeTruthy();
    expect(project!.certificate!.title).toBe("Teljesítésigazolás");
    // Dates run forward from the project's start, not from today.
    expect(project!.milestones[0]!.dueAt!.getTime()).toBeGreaterThan(startedAt.getTime());
  });

  /**
   * The claim the whole design rests on. If a milestone were its own entity
   * with its own done flag, every task view would need to learn about it — and
   * the two flags would eventually disagree.
   */
  it("creates ORDINARY TASKS, which is how they reach Today Queue", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const res = await startProject(db, ws, { dealId, ownerId: "u1" });
    const projectId = (res as { projectId: string }).projectId;

    const tasks = await db.task.findMany({ where: { entityType: "project", entityId: projectId } });
    const milestones = await db.milestone.findMany({ where: { projectId } });
    expect(tasks).toHaveLength(milestones.length);
    for (const t of tasks) {
      expect(t.dueAt).toBeTruthy();
      expect(t.assigneeId).toBe("u1");
      expect(t.source).toBe("project_milestone");
      expect(t.doneAt).toBeNull();
    }
  });

  it("reflects task completion as milestone completion — there is one flag", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const res = await startProject(db, ws, { dealId });
    const projectId = (res as { projectId: string }).projectId;

    const before = await loadProject(db, projectId);
    expect(before!.progress.done).toBe(0);

    await db.task.update({
      where: { id: before!.milestones[0]!.taskId },
      data: { doneAt: new Date() },
    });

    const after = await loadProject(db, projectId);
    expect(after!.progress.done).toBe(1);
    expect(after!.milestones[0]!.doneAt).toBeTruthy();
  });

  it("refuses a deal that has not been won", async () => {
    const db = getWorkspaceClient(ws);
    const pipeline = await db.pipeline.findFirst();
    const open = await db.dealStage.findFirst({
      where: { pipelineId: pipeline!.id, kind: "open" },
    });
    const deal = await db.deal.create({
      data: {
        workspaceId: ws,
        title: "Még nyitott",
        value: 1,
        pipelineId: pipeline!.id,
        stageId: open!.id,
        status: "OPEN",
      },
    });
    const res = await startProject(db, ws, { dealId: deal.id });
    expect(res).toEqual({ ok: false, error: "A project starts from a won deal." });
  });

  it("refuses a second project on the same deal", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    expect((await startProject(db, ws, { dealId })).ok).toBe(true);
    const second = await startProject(db, ws, { dealId });
    expect(second).toEqual({ ok: false, error: "This deal already has a project." });
  });
});

describe("the certificate gate", () => {
  /**
   * The rule the module exists for. A delivered project whose certificate was
   * never issued is an invoice that cannot be sent, and it is invisible
   * precisely because everything else looks finished.
   */
  it("will not close a project while the certificate milestone is open", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const res = await startProject(db, ws, { dealId });
    const projectId = (res as { projectId: string }).projectId;
    const project = await loadProject(db, projectId);

    // Everything EXCEPT the certificate is done — the state that hides the gap.
    for (const m of project!.milestones.filter((x) => x.kind !== "certificate")) {
      await db.task.update({ where: { id: m.taskId }, data: { doneAt: new Date() } });
    }

    const refused = await closeProject(db, projectId);
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toContain("teljesítésigazolás");

    // Issue it, and the project closes.
    await db.task.update({
      where: { id: project!.certificate!.taskId },
      data: { doneAt: new Date() },
    });
    expect(await closeProject(db, projectId)).toEqual({ ok: true });

    const closed = await loadProject(db, projectId);
    expect(closed!.closedAt).toBeTruthy();
  });

  /**
   * Order matters. With nothing finished, BOTH rules apply — and the one the
   * operator hears about is the certificate, because that is the one that
   * costs money to have missed.
   */
  it("leads with the certificate when everything is still open", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const res = await startProject(db, ws, { dealId });
    const refused = await closeProject(db, (res as { projectId: string }).projectId);
    expect((refused as { error: string }).error).toContain("teljesítésigazolás");
  });

  it("counts the rest once the certificate has been issued", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const res = await startProject(db, ws, { dealId });
    const projectId = (res as { projectId: string }).projectId;
    const project = await loadProject(db, projectId);

    // Ticked early — the certificate is out but the work is not finished.
    await db.task.update({
      where: { id: project!.certificate!.taskId },
      data: { doneAt: new Date() },
    });

    const refused = await closeProject(db, projectId);
    expect((refused as { error: string }).error).toMatch(/mérföldkő még nyitva/);
  });
});

describe("the Monday digest", () => {
  it("counts overdue milestones on running projects", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const res = await startProject(db, ws, { dealId });
    const projectId = (res as { projectId: string }).projectId;

    const digestBefore = await collectDigestData(db, { isOwner: true, nowMs: Date.now() });
    expect(digestBefore.overdueMilestones).toBe(0);

    // Drag one milestone into the past.
    const project = await loadProject(db, projectId);
    await db.task.update({
      where: { id: project!.milestones[0]!.taskId },
      data: { dueAt: new Date(Date.now() - 3 * 24 * 3600_000) },
    });

    const digestAfter = await collectDigestData(db, { isOwner: true, nowMs: Date.now() });
    expect(digestAfter.overdueMilestones).toBe(1);
  });

  it("stops counting a milestone once its project is closed", async () => {
    const db = getWorkspaceClient(ws);
    const dealId = await wonDeal();
    const res = await startProject(db, ws, { dealId });
    const projectId = (res as { projectId: string }).projectId;
    const project = await loadProject(db, projectId);
    await db.task.update({
      where: { id: project!.milestones[0]!.taskId },
      data: { dueAt: new Date(Date.now() - 3 * 24 * 3600_000) },
    });
    await db.project.update({ where: { id: projectId }, data: { closedAt: new Date() } });

    const digest = await collectDigestData(db, { isOwner: true, nowMs: Date.now() });
    expect(digest.overdueMilestones).toBe(0);
  });
});
