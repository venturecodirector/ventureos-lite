import type { WorkspaceClient } from "@/lib/db";
import { dueInDays, type TaskType } from "./logic";

/**
 * Turning a system signal into a real task (playbook-v2 P3/3).
 *
 * Three features already wrote a `suggestedTask` string into an activity
 * payload and hoped something would render it: audit watches when a prospect's
 * site worsens (P2/5), keyword drops for a client (P2/7), and warm inbound from
 * the self-serve landing (P12/1c). Nothing did, so that work was being recorded
 * and thrown away. This is what they meant.
 *
 * IDEMPOTENT BY SOURCE. A daily sweep that re-detects the same worsening must
 * not produce a task a day: one open task per (entity, source) is the rule, and
 * a second detection updates the existing one rather than stacking.
 */
export interface SignalTaskInput {
  workspaceId: string;
  title: string;
  note?: string | null;
  type?: TaskType;
  entityType: "lead" | "company";
  entityId: string;
  /** Stable identifier for the kind of signal, e.g. "audit_worsened". */
  source: string;
  /** Days from now. Same-day for things that decay fast. */
  dueInDays?: number;
}

export async function createTaskFromSignal(
  db: WorkspaceClient,
  input: SignalTaskInput,
): Promise<string | null> {
  try {
    const existing = await db.task.findFirst({
      where: {
        entityType: input.entityType,
        entityId: input.entityId,
        source: input.source,
        doneAt: null,
      },
      select: { id: true },
    });

    const dueAt = dueInDays(input.dueInDays ?? 1);

    if (existing) {
      // Refresh rather than duplicate: the signal fired again, so the title and
      // the deadline are newer, but it is still one piece of work.
      await db.task.update({
        where: { id: existing.id },
        data: { title: input.title, note: input.note ?? null, dueAt },
      });
      return existing.id;
    }

    const task = await db.task.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title,
        note: input.note ?? null,
        type: input.type ?? "todo",
        entityType: input.entityType,
        entityId: input.entityId,
        source: input.source,
        dueAt,
      },
      select: { id: true },
    });
    return task.id;
  } catch {
    // A task is a convenience on top of a signal that is already recorded as an
    // activity. Failing to create it must never fail the thing that detected it.
    return null;
  }
}
