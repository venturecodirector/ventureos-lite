"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { TASK_TYPES, groupTasks, orderTasks, type GroupedTasks, type TaskLike } from "./logic";

/**
 * Tasks (playbook-v2 P3/3).
 *
 * Everything goes through the guarded client, so a task is scoped to its
 * workspace by the same mechanism as every other business row.
 */
export interface TaskView extends TaskLike {
  type: string;
  assigneeId: string | null;
  /** Resolved label for whatever the task hangs off, for the list view. */
  entityLabel: string | null;
  entityHref: string | null;
}

const createSchema = z.object({
  title: z.string().trim().min(2).max(200),
  type: z.enum(TASK_TYPES).default("todo"),
  note: z.string().trim().max(2000).optional(),
  /** ISO date or datetime; omitted means no deadline. */
  dueAt: z.string().optional(),
  entityType: z.enum(["lead", "company", "document"]).optional(),
  entityId: z.string().optional(),
  assigneeId: z.string().optional(),
});

export async function createTask(raw: unknown): Promise<{ id: string }> {
  const input = createSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const task = await db.task.create({
    data: {
      workspaceId,
      title: input.title,
      type: input.type,
      note: input.note || null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      // Unassigned by default rather than silently mine: a task nobody owns
      // should look like one.
      assigneeId: input.assigneeId ?? userId,
      createdBy: userId,
    },
    select: { id: true },
  });

  revalidatePath("/");
  revalidatePath("/leads");
  return { id: task.id };
}

export async function completeTask(taskId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.task.updateMany({
    where: { id: taskId, doneAt: null },
    data: { doneAt: new Date() },
  });
  revalidatePath("/");
  revalidatePath("/leads");
  return { ok: true };
}

/** Undo, because a mis-click on a checkbox should not need a database. */
export async function reopenTask(taskId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.task.updateMany({ where: { id: taskId }, data: { doneAt: null } });
  revalidatePath("/");
  revalidatePath("/leads");
  return { ok: true };
}

export async function snoozeTask(taskId: string, days: number): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  // Snoozed from TODAY, not from the old due date: a task three weeks overdue
  // snoozed by "3 days" means three days from now, not eighteen days ago.
  const due = new Date();
  due.setDate(due.getDate() + days);
  due.setHours(17, 0, 0, 0);
  await db.task.updateMany({ where: { id: taskId }, data: { dueAt: due } });
  revalidatePath("/");
  return { ok: true };
}

export async function deleteTask(taskId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.task.deleteMany({ where: { id: taskId } });
  revalidatePath("/");
  revalidatePath("/leads");
  return { ok: true };
}

/**
 * Resolve the polymorphic link to something displayable.
 *
 * Done in one batch per entity type rather than per task: a list of thirty
 * tasks should be four queries, not thirty-one.
 */
async function decorate(
  db: ReturnType<typeof getWorkspaceClient>,
  rows: Array<{
    id: string;
    type: string;
    title: string;
    note: string | null;
    dueAt: Date | null;
    doneAt: Date | null;
    entityType: string | null;
    entityId: string | null;
    assigneeId: string | null;
    source: string | null;
  }>,
): Promise<TaskView[]> {
  const leadIds = rows.filter((r) => r.entityType === "lead" && r.entityId).map((r) => r.entityId!);
  const companyIds = rows
    .filter((r) => r.entityType === "company" && r.entityId)
    .map((r) => r.entityId!);

  const [leads, companies] = await Promise.all([
    leadIds.length
      ? db.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, contactName: true, company: { select: { name: true } } },
        })
      : Promise.resolve([]),
    companyIds.length
      ? db.company.findMany({
          where: { id: { in: companyIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const leadLabel = new Map(
    leads.map((l) => [l.id, l.contactName || l.company?.name || "lead"]),
  );
  const companyLabel = new Map(companies.map((c) => [c.id, c.name]));

  return rows.map((r) => {
    let entityLabel: string | null = null;
    let entityHref: string | null = null;
    if (r.entityType === "lead" && r.entityId) {
      entityLabel = leadLabel.get(r.entityId) ?? null;
      entityHref = `/leads?lead=${r.entityId}`;
    } else if (r.entityType === "company" && r.entityId) {
      entityLabel = companyLabel.get(r.entityId) ?? null;
      entityHref = `/leads?company=${r.entityId}`;
    } else if (r.entityType === "document" && r.entityId) {
      entityLabel = "document";
      entityHref = `/documents?doc=${r.entityId}`;
    }
    return { ...r, entityLabel, entityHref };
  });
}

/** Open tasks, grouped for the dashboard. */
export async function myTasks(): Promise<GroupedTasks<TaskView>> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const rows = await db.task.findMany({
    where: {
      doneAt: null,
      // Unassigned tasks show up for everyone: an owner nobody set is not a
      // reason for work to disappear.
      OR: [{ assigneeId: userId }, { assigneeId: null }],
    },
    orderBy: { dueAt: "asc" },
    // Bounded: this renders a panel, and nobody reads two hundred tasks in one.
    // It also keeps the dashboard — the first page loaded every morning — from
    // paying for a list that scrolls past usefulness.
    take: 50,
    select: {
      id: true,
      type: true,
      title: true,
      note: true,
      dueAt: true,
      doneAt: true,
      entityType: true,
      entityId: true,
      assigneeId: true,
      source: true,
    },
  });

  return groupTasks(await decorate(db, rows));
}

/** Everything on one entity, done included, newest completion last. */
export async function tasksForEntity(
  entityType: "lead" | "company" | "document",
  entityId: string,
): Promise<TaskView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const rows = await db.task.findMany({
    where: { entityType, entityId },
    orderBy: [{ doneAt: "asc" }, { dueAt: "asc" }],
    take: 100,
    select: {
      id: true,
      type: true,
      title: true,
      note: true,
      dueAt: true,
      doneAt: true,
      entityType: true,
      entityId: true,
      assigneeId: true,
      source: true,
    },
  });

  const decorated = await decorate(db, rows);
  return orderTasks(decorated);
}
