/**
 * Where workflow rules are fired from (playbook-v2 P7/5).
 *
 * One function per trigger, each of them BEST-EFFORT and each of them the last
 * thing its caller does. An automation is a convenience layered on top of an
 * action; it must never be the reason the action fails, and a rule that throws
 * must not roll back a stage move somebody made deliberately.
 *
 * A short-circuit read comes first: `hasRulesFor` is one indexed count, and it
 * keeps the common case — a workspace with no rules at all — down to a query
 * rather than a fact-gathering pass nobody will use.
 */

import { getWorkspaceClient } from "@/lib/db";
import { dealFacts, fireWorkflow, leadFacts } from "./engine";
import type { Trigger } from "./types";

async function hasRulesFor(workspaceId: string, trigger: Trigger): Promise<boolean> {
  const db = getWorkspaceClient(workspaceId);
  return (await db.workflowRule.count({ where: { trigger, enabled: true } })) > 0;
}

function swallow(where: string) {
  return (e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[workflow] ${where} failed`, e);
    return 0;
  };
}

export async function onLeadStageChanged(
  workspaceId: string,
  leadId: string,
): Promise<number> {
  try {
    if (!(await hasRulesFor(workspaceId, "lead_stage_changed"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "lead_stage_changed",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts,
    });
  } catch (e) {
    return swallow("lead_stage_changed")(e);
  }
}

export async function onLeadCreated(workspaceId: string, leadId: string): Promise<number> {
  try {
    if (!(await hasRulesFor(workspaceId, "lead_created"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "lead_created",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts,
    });
  } catch (e) {
    return swallow("lead_created")(e);
  }
}

export async function onDealStageChanged(
  workspaceId: string,
  dealId: string,
): Promise<number> {
  try {
    if (!(await hasRulesFor(workspaceId, "deal_stage_changed"))) return 0;
    const loaded = await dealFacts(workspaceId, dealId);
    if (!loaded) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "deal_stage_changed",
      entityType: "deal",
      entityId: dealId,
      leadId: loaded.leadId,
      facts: loaded.facts,
    });
  } catch (e) {
    return swallow("deal_stage_changed")(e);
  }
}

export async function onQuoteAccepted(
  workspaceId: string,
  leadId: string | null,
): Promise<number> {
  try {
    if (!leadId) return 0;
    if (!(await hasRulesFor(workspaceId, "quote_accepted"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "quote_accepted",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts,
    });
  } catch (e) {
    return swallow("quote_accepted")(e);
  }
}

export async function onMeetingOutcome(
  workspaceId: string,
  leadId: string | null,
  outcome: string | null,
): Promise<number> {
  try {
    if (!leadId) return 0;
    if (!(await hasRulesFor(workspaceId, "meeting_outcome_logged"))) return 0;
    const facts = await leadFacts(workspaceId, leadId);
    if (!facts) return 0;
    return fireWorkflow(workspaceId, {
      trigger: "meeting_outcome_logged",
      entityType: "lead",
      entityId: leadId,
      leadId,
      facts: { ...facts, meetingOutcome: outcome },
    });
  } catch (e) {
    return swallow("meeting_outcome_logged")(e);
  }
}

/**
 * The daily overdue sweep.
 *
 * Checked once a day rather than the moment the clock passes, and the trigger
 * copy says so: a rule that fires the second a task turns overdue would fire at
 * 17:00:01, which is nobody's idea of "overdue by two days".
 */
export async function processWorkflowOverdueSweep(
  nowMs: number = Date.now(),
): Promise<number> {
  const { prismaUnsafe } = await import("@/lib/db");
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true } });
  let fired = 0;

  for (const ws of workspaces) {
    try {
      if (!(await hasRulesFor(ws.id, "task_overdue"))) continue;
      const db = getWorkspaceClient(ws.id);
      const overdue = await db.task.findMany({
        where: { doneAt: null, dueAt: { not: null, lt: new Date(nowMs) } },
        select: { id: true, entityType: true, entityId: true, dueAt: true, title: true },
        take: 500,
      });

      for (const task of overdue) {
        const overdueDays = Math.floor((nowMs - task.dueAt!.getTime()) / 86_400_000);
        const leadId = task.entityType === "lead" ? task.entityId : null;
        const facts = leadId ? await leadFacts(ws.id, leadId) : null;
        fired += await fireWorkflow(ws.id, {
          trigger: "task_overdue",
          entityType: "lead",
          entityId: leadId ?? task.id,
          leadId,
          facts: { ...(facts ?? {}), overdueDays, taskTitle: task.title },
        });
      }
    } catch (e) {
      swallow("task_overdue sweep")(e);
    }
  }
  return fired;
}
