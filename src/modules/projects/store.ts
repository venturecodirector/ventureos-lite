import type { WorkspaceClient } from "@/lib/db";
import { milestoneDueAt, parseMilestones, projectProgress, SEED_TEMPLATES } from "./templates";

/**
 * Projects against the database (playbook-v3 P11/2).
 *
 * Every milestone here creates a Task and then points at it. Nothing about a
 * milestone's title, date, owner or done state is stored twice.
 */

/** Marks the tasks this module owns, so they are recognisable everywhere else. */
export const MILESTONE_TASK_SOURCE = "project_milestone";

export interface ProjectMilestoneView {
  id: string;
  taskId: string;
  title: string;
  kind: "generic" | "certificate";
  position: number;
  dueAt: Date | null;
  doneAt: Date | null;
  assigneeId: string | null;
  note: string | null;
}

export interface ProjectView {
  id: string;
  dealId: string;
  name: string;
  startedAt: Date;
  closedAt: Date | null;
  companyName: string | null;
  milestones: ProjectMilestoneView[];
  progress: ReturnType<typeof projectProgress>;
  /** The certificate milestone, when the template has one. */
  certificate: ProjectMilestoneView | null;
}

/** Make sure a workspace has something to start a project from. */
export async function ensureTemplates(
  db: WorkspaceClient,
  workspaceId: string,
): Promise<void> {
  const existing = await db.projectTemplate.count({ where: { status: "active" } });
  if (existing > 0) return;
  for (const seed of SEED_TEMPLATES) {
    await db.projectTemplate.create({
      data: {
        workspaceId,
        name: seed.name,
        milestones: seed.milestones as unknown as object,
      },
    });
  }
}

export interface StartProjectInput {
  dealId: string;
  templateId?: string | null;
  name?: string | null;
  startedAt?: Date;
  ownerId?: string | null;
  createdBy?: string | null;
}

export type StartProjectResult =
  | { ok: true; projectId: string }
  | { ok: false; error: string };

/**
 * Turn a won deal into a checklist.
 *
 * Refuses on anything but a WON deal, and refuses a second project on the same
 * deal — the deal is the unit of delivery, and two checklists for one signature
 * is how two people end up each waiting for the other to issue the certificate.
 */
export async function startProject(
  db: WorkspaceClient,
  workspaceId: string,
  input: StartProjectInput,
): Promise<StartProjectResult> {
  const deal = await db.deal.findUnique({
    where: { id: input.dealId },
    select: { id: true, title: true, status: true, companyId: true, leadId: true },
  });
  if (!deal) return { ok: false, error: "Deal not found." };
  if (deal.status !== "WON") {
    return { ok: false, error: "A project starts from a won deal." };
  }

  const existing = await db.project.findUnique({ where: { dealId: deal.id } });
  if (existing) return { ok: false, error: "This deal already has a project." };

  await ensureTemplates(db, workspaceId);
  const template = input.templateId
    ? await db.projectTemplate.findUnique({ where: { id: input.templateId } })
    : await db.projectTemplate.findFirst({
        where: { status: "active" },
        orderBy: { createdAt: "asc" },
      });
  if (!template) return { ok: false, error: "No milestone template to start from." };

  const milestones = parseMilestones(template.milestones);
  if (milestones.length === 0) {
    return { ok: false, error: "That template has no milestones." };
  }

  const startedAt = input.startedAt ?? new Date();
  const project = await db.project.create({
    data: {
      workspaceId,
      dealId: deal.id,
      companyId: deal.companyId,
      leadId: deal.leadId,
      name: input.name?.trim() || deal.title,
      templateId: template.id,
      templateVersion: template.version,
      startedAt,
      createdBy: input.createdBy ?? null,
    },
  });

  for (const [index, m] of milestones.entries()) {
    const task = await db.task.create({
      data: {
        workspaceId,
        type: "todo",
        title: m.title,
        dueAt: milestoneDueAt(startedAt, m.dayOffset),
        // Pointed at the PROJECT: the task views already render an entity link,
        // and a milestone belongs to its checklist rather than to the deal.
        entityType: "project",
        entityId: project.id,
        assigneeId: input.ownerId ?? null,
        source: MILESTONE_TASK_SOURCE,
        createdBy: input.createdBy ?? null,
      },
    });
    await db.milestone.create({
      data: {
        workspaceId,
        projectId: project.id,
        taskId: task.id,
        position: index,
        kind: m.kind,
      },
    });
  }

  return { ok: true, projectId: project.id };
}

/** Load one project with its checklist, resolved through the tasks. */
export async function loadProject(
  db: WorkspaceClient,
  projectId: string,
): Promise<ProjectView | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { milestones: { orderBy: { position: "asc" } } },
  });
  if (!project) return null;

  const tasks = await db.task.findMany({
    where: { id: { in: project.milestones.map((m) => m.taskId) } },
    select: {
      id: true,
      title: true,
      dueAt: true,
      doneAt: true,
      assigneeId: true,
      note: true,
    },
  });
  const byTask = new Map(tasks.map((t) => [t.id, t]));

  const milestones: ProjectMilestoneView[] = project.milestones
    .map((m) => {
      const t = byTask.get(m.taskId);
      if (!t) return null;
      return {
        id: m.id,
        taskId: m.taskId,
        title: t.title,
        kind: m.kind === "certificate" ? ("certificate" as const) : ("generic" as const),
        position: m.position,
        dueAt: t.dueAt,
        doneAt: t.doneAt,
        assigneeId: t.assigneeId,
        note: t.note,
      };
    })
    .filter((m): m is ProjectMilestoneView => m !== null);

  const company = project.companyId
    ? await db.company.findUnique({
        where: { id: project.companyId },
        select: { name: true },
      })
    : null;

  return {
    id: project.id,
    dealId: project.dealId,
    name: project.name,
    startedAt: project.startedAt,
    closedAt: project.closedAt,
    companyName: company?.name ?? null,
    milestones,
    progress: projectProgress(milestones),
    certificate: milestones.find((m) => m.kind === "certificate") ?? null,
  };
}

export type CloseResult = { ok: true } | { ok: false; error: string };

/**
 * Close a project — but not over an open certificate.
 *
 * This is the rule the whole module exists for. A delivered project whose
 * certificate was never issued is an invoice that cannot be sent, and it is
 * invisible precisely because everything else looks finished.
 */
export async function closeProject(
  db: WorkspaceClient,
  projectId: string,
): Promise<CloseResult> {
  const project = await loadProject(db, projectId);
  if (!project) return { ok: false, error: "Project not found." };
  if (project.closedAt) return { ok: true };

  if (project.certificate && !project.certificate.doneAt) {
    return {
      ok: false,
      error: "A teljesítésigazolás még nincs kiállítva — enélkül a projekt nem zárható le.",
    };
  }
  const open = project.milestones.filter((m) => !m.doneAt).length;
  if (open > 0) {
    return { ok: false, error: `${open} mérföldkő még nyitva van.` };
  }

  await db.project.update({ where: { id: projectId }, data: { closedAt: new Date() } });
  return { ok: true };
}
