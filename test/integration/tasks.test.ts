import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { createTaskFromSignal } from "@/modules/tasks/from-signal";
import { eraseLeadData } from "@/modules/gdpr/erase";

/**
 * playbook-v2 P3/3 — the polymorphic link, signal adoption, and erasure.
 *
 * The idempotence test is the important one: a daily sweep that re-detects the
 * same worsening site must not produce a task a day. Without it, the feature
 * that makes signals useful is also the feature that buries the list.
 */
const RUN = Math.random().toString(36).slice(2, 8);
let workspaceId = "";
let leadId = "";
let companyId = "";

beforeAll(async () => {
  const ws = await prismaUnsafe.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  workspaceId = ws!.id;

  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.create({
    data: { workspaceId, name: `Task Co ${RUN}`, domain: `task-${RUN}.hu` },
    select: { id: true },
  });
  companyId = company.id;
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId,
      source: "PROSPECTOR",
      stage: "RESEARCHED",
      contactName: `Task Lead ${RUN}`,
    },
    select: { id: true },
  });
  leadId = lead.id;
});

afterAll(async () => {
  await prismaUnsafe.task.deleteMany({ where: { entityId: { in: [leadId, companyId] } } });
  await prismaUnsafe.lead.deleteMany({ where: { id: leadId } });
  await prismaUnsafe.company.deleteMany({ where: { id: companyId } });
  await prismaUnsafe.$disconnect();
});

describe("polymorphic linking", () => {
  it("attaches a task to a lead and to a company independently", async () => {
    const db = getWorkspaceClient(workspaceId);
    const onLead = await createTaskFromSignal(db, {
      workspaceId,
      title: `Call ${RUN}`,
      entityType: "lead",
      entityId: leadId,
      source: `test_lead_${RUN}`,
    });
    const onCompany = await createTaskFromSignal(db, {
      workspaceId,
      title: `Check ${RUN}`,
      entityType: "company",
      entityId: companyId,
      source: `test_company_${RUN}`,
    });

    expect(onLead).not.toBeNull();
    expect(onCompany).not.toBeNull();

    const leadTasks = await db.task.findMany({ where: { entityType: "lead", entityId: leadId } });
    const companyTasks = await db.task.findMany({
      where: { entityType: "company", entityId: companyId },
    });
    expect(leadTasks.length).toBeGreaterThanOrEqual(1);
    expect(companyTasks.length).toBeGreaterThanOrEqual(1);
    // A company task must not appear on the lead, and vice versa.
    expect(leadTasks.map((t) => t.id)).not.toContain(onCompany);
  });
});

describe("signal adoption is idempotent", () => {
  it("does not stack a task each time the same signal fires", async () => {
    const db = getWorkspaceClient(workspaceId);
    const source = `audit_worsened_${RUN}`;

    const first = await createTaskFromSignal(db, {
      workspaceId,
      title: "Romlott az oldaluk",
      entityType: "lead",
      entityId: leadId,
      source,
    });
    const second = await createTaskFromSignal(db, {
      workspaceId,
      title: "Romlott az oldaluk — újra",
      entityType: "lead",
      entityId: leadId,
      source,
    });

    // Same task, refreshed — a daily sweep must not produce a task a day.
    expect(second).toBe(first);
    const all = await db.task.findMany({ where: { entityId: leadId, source } });
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toContain("újra");
  });

  it("creates a fresh task once the previous one is done", async () => {
    const db = getWorkspaceClient(workspaceId);
    const source = `keyword_dropped_${RUN}`;

    const first = await createTaskFromSignal(db, {
      workspaceId,
      title: "Kiesett a top 10-ből",
      entityType: "company",
      entityId: companyId,
      source,
    });
    await db.task.update({ where: { id: first! }, data: { doneAt: new Date() } });

    // The signal firing again after the work was done is new work, not a
    // duplicate of finished work.
    const second = await createTaskFromSignal(db, {
      workspaceId,
      title: "Kiesett újra",
      entityType: "company",
      entityId: companyId,
      source,
    });
    expect(second).not.toBe(first);
    const all = await db.task.findMany({ where: { entityId: companyId, source } });
    expect(all).toHaveLength(2);
  });
});

describe("erasure", () => {
  it("deletes a lead's tasks, which no cascade would have taken", async () => {
    const db = getWorkspaceClient(workspaceId);
    await createTaskFromSignal(db, {
      workspaceId,
      title: `Erase me ${RUN}`,
      entityType: "lead",
      entityId: leadId,
      source: `erase_${RUN}`,
    });
    expect(
      await db.task.count({ where: { entityType: "lead", entityId: leadId } }),
    ).toBeGreaterThan(0);

    await eraseLeadData(db, leadId, { eraseDocuments: true });

    // Polymorphic means no foreign key, so without the explicit delete these
    // rows would outlive the lead with its name in their titles.
    expect(await db.task.count({ where: { entityType: "lead", entityId: leadId } })).toBe(0);
    // The company's tasks are untouched: erasing a lead is not erasing a company.
    expect(
      await db.task.count({ where: { entityType: "company", entityId: companyId } }),
    ).toBeGreaterThan(0);
  });
});
