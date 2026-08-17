/**
 * Running workflow rules (playbook-v2 P7/5).
 *
 * Workspace-id in rather than session-derived, like every other engine here.
 * The trigger points call `fireWorkflow` and never wait on it for correctness:
 * an automation failing must not fail the stage move that caused it.
 *
 * CLAUDE.md hard rule #2 lives in `runDraftEmail`: the email action writes a
 * Message with status DRAFT and nothing else. There is no send path from here,
 * and the human-edit guardrail (#6) still applies to it downstream, because it
 * is an ordinary draft on an ordinary lead.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { readValues } from "@/modules/fields/types";
import { wakeUpDate } from "@/modules/pipeline/schedule";
import { safeDeliver } from "@/modules/notifications/notify";
import {
  ROOT_CHAIN,
  canRun,
  conditionsMatch,
  descend,
  type Action,
  type ChainContext,
  type Condition,
  type Trigger,
  type WorkflowFacts,
} from "./types";

export interface WorkflowEvent {
  trigger: Trigger;
  /** lead | deal — what the actions act on. */
  entityType: "lead" | "deal";
  entityId: string;
  /** The lead the actions attach to. A deal event carries its lead's id here. */
  leadId: string | null;
  facts: WorkflowFacts;
  chain?: ChainContext;
}

interface LoadedRule {
  id: string;
  name: string;
  version: number;
  trigger: string;
  triggerConfig: Record<string, unknown>;
  conditions: Condition[];
  actions: Action[];
}

type Db = ReturnType<typeof getWorkspaceClient>;

/**
 * Does the trigger's own configuration match?
 *
 * Separate from the conditions because it is not a condition — "when a lead
 * reaches Contacted" is part of WHICH event this rule listens for, and a rule
 * whose stage does not match should not appear in the log as a considered
 * no-match every time any lead moves anywhere.
 */
function triggerMatches(rule: LoadedRule, event: WorkflowEvent): boolean {
  const config = rule.triggerConfig ?? {};
  switch (rule.trigger as Trigger) {
    case "lead_stage_changed":
      return !config.stage || String(config.stage) === String(event.facts.stage ?? "");
    case "deal_stage_changed":
      return !config.stage || String(config.stage) === String(event.facts.dealStage ?? "");
    case "lead_created":
      return !config.source || String(config.source) === String(event.facts.source ?? "");
    case "task_overdue": {
      const needed = Number(config.days ?? 0);
      const actual = Number(event.facts.overdueDays ?? 0);
      return Number.isFinite(needed) ? actual >= needed : true;
    }
    default:
      return true;
  }
}

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
}

/**
 * Evaluate every enabled rule for this event.
 *
 * Every evaluation is LOGGED, including the no-matches: "why did my rule not
 * fire?" is the question an execution log exists to answer, and a log that
 * records only successes cannot answer it.
 */
export async function fireWorkflow(
  workspaceId: string,
  event: WorkflowEvent,
): Promise<number> {
  const chain = event.chain ?? ROOT_CHAIN;
  const db = getWorkspaceClient(workspaceId);

  const rules = (await db.workflowRule.findMany({
    where: { trigger: event.trigger, enabled: true },
    orderBy: { createdAt: "asc" },
  })) as unknown as Array<LoadedRule & { enabled: boolean }>;

  let fired = 0;
  for (const rule of rules) {
    if (!triggerMatches(rule, event)) continue;

    const verdict = canRun(rule, chain);
    if (!verdict.allowed) {
      await log(db, workspaceId, rule, event, chain, "skipped", [], {
        detail:
          verdict.reason === "self_trigger"
            ? "Skipped: this rule already ran for this event, so it cannot re-trigger itself."
            : `Skipped: ${chain.depth} rules have already run for this event (the chain limit).`,
      });
      continue;
    }

    if (!conditionsMatch(event.facts, rule.conditions ?? [])) {
      await log(db, workspaceId, rule, event, chain, "no_match", [], {
        detail: "Conditions did not match.",
      });
      continue;
    }

    const results: ActionResult[] = [];
    for (const action of rule.actions ?? []) {
      try {
        results.push(await runAction(db, workspaceId, event, action));
      } catch (e) {
        results.push({ type: action.type, ok: false, detail: (e as Error).message });
      }
    }

    const failures = results.filter((r) => !r.ok);
    await log(
      db,
      workspaceId,
      rule,
      event,
      chain,
      failures.length === results.length && results.length > 0 ? "failed" : "matched",
      results,
      {
        detail:
          failures.length === 0
            ? results.map((r) => r.detail).join("; ")
            : `${results.length - failures.length} of ${results.length} actions ran; ${failures
                .map((f) => f.detail)
                .join("; ")}`,
      },
    );
    fired += 1;

    // Anything a rule's actions cause is one level deeper. Descending here
    // rather than inside each action means the depth counts RULES, which is
    // what the limit is about.
    event.chain = descend(rule, chain);
  }

  return fired;
}

async function log(
  db: Db,
  workspaceId: string,
  rule: LoadedRule,
  event: WorkflowEvent,
  chain: ChainContext,
  status: string,
  results: ActionResult[],
  opts: { detail: string },
): Promise<void> {
  await db.workflowRun
    .create({
      data: {
        workspaceId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        trigger: event.trigger,
        entityType: event.entityType,
        entityId: event.entityId,
        status,
        detail: opts.detail,
        results: results as unknown as object[],
        depth: chain.depth,
      },
    })
    .catch(() => {
      /* the log is evidence, not a dependency — never fail a rule over it */
    });
}

// ---- the actions --------------------------------------------------------------

async function runAction(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  switch (action.type) {
    case "create_task":
      return runCreateTask(db, workspaceId, event, action);
    case "draft_email":
      return runDraftEmail(db, workspaceId, event, action);
    case "add_signal":
    case "remove_signal":
      return runSignal(db, event, action);
    case "move_not_now":
      return runNotNow(db, event);
    case "notify_user":
      return runNotify(workspaceId, event, action);
    default:
      return { type: action.type, ok: false, detail: "Unknown action." };
  }
}

async function runCreateTask(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  const due = new Date();
  due.setDate(due.getDate() + (action.dueInDays ?? 1));
  due.setHours(17, 0, 0, 0);

  await db.task.create({
    data: {
      workspaceId,
      title: action.title ?? "Follow up",
      type: action.taskType ?? "todo",
      dueAt: due,
      entityType: event.entityType,
      entityId: event.entityId,
      // Stamped so the Today Queue can say WHY this task exists — a task that
      // appeared on its own with no explanation is a task people ignore.
      source: "workflow",
    },
  });
  return { type: action.type, ok: true, detail: `Created task “${action.title ?? "Follow up"}”` };
}

/**
 * CLAUDE.md hard rule #2. This writes a DRAFT and stops.
 *
 * Status DRAFT, `aiDrafted` false (a template is not Claude), and no send path
 * of any kind. A person opens the lead, reads it, edits it and sends it — and
 * the human-edit guardrail applies to it downstream exactly as it does to
 * anything else on that lead.
 */
async function runDraftEmail(
  db: Db,
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  if (!event.leadId) {
    return { type: action.type, ok: false, detail: "No lead to draft against." };
  }

  let body = action.body ?? "";
  let subject = action.subject ?? "";
  if (action.templateId) {
    const template = await db.template.findUnique({
      where: { id: action.templateId },
      select: { body: true, name: true, type: true },
    });
    if (!template || template.type !== "EMAIL") {
      return { type: action.type, ok: false, detail: "That email template no longer exists." };
    }
    body = template.body;
    subject = subject || template.name;
  }
  if (!body.trim()) {
    return { type: action.type, ok: false, detail: "Nothing to draft — no template and no body." };
  }

  await db.message.create({
    data: {
      workspaceId,
      leadId: event.leadId,
      direction: "OUTBOUND",
      channel: "EMAIL",
      kind: "workflow_draft",
      body: subject ? `${subject}\n\n${body}` : body,
      // Not Claude's work, so not an AI draft — the flag means something
      // specific (rule #6) and must not be borrowed for "generated somehow".
      aiDrafted: false,
      status: "DRAFT",
    },
  });
  return {
    type: action.type,
    ok: true,
    detail: "Prepared an email draft — a person must review and send it",
  };
}

async function runSignal(db: Db, event: WorkflowEvent, action: Action): Promise<ActionResult> {
  if (!event.leadId) return { type: action.type, ok: false, detail: "No lead." };
  const tag = (action.signal ?? "").trim();
  if (!tag) return { type: action.type, ok: false, detail: "No signal named." };

  const lead = await db.lead.findUnique({
    where: { id: event.leadId },
    select: { signals: true },
  });
  if (!lead) return { type: action.type, ok: false, detail: "Lead not found." };

  const current = Array.isArray(lead.signals) ? (lead.signals as string[]) : [];
  const next =
    action.type === "add_signal"
      ? current.includes(tag)
        ? current
        : [...current, tag]
      : current.filter((s) => s !== tag);

  if (next.length === current.length && action.type === "add_signal") {
    return { type: action.type, ok: true, detail: `Signal “${tag}” was already there` };
  }
  await db.lead.update({ where: { id: event.leadId }, data: { signals: next } });
  return {
    type: action.type,
    ok: true,
    detail: `${action.type === "add_signal" ? "Added" : "Removed"} signal “${tag}”`,
  };
}

async function runNotNow(db: Db, event: WorkflowEvent): Promise<ActionResult> {
  if (!event.leadId) return { type: "move_not_now", ok: false, detail: "No lead." };
  const now = new Date();
  await db.lead.update({
    where: { id: event.leadId },
    data: {
      stage: "NOT_NOW",
      stageEnteredAt: now,
      // The usual wake-up, so it resurfaces rather than disappearing.
      wakeUpAt: wakeUpDate(now),
    },
  });
  return { type: "move_not_now", ok: true, detail: "Moved to Not now with a wake-up date" };
}

async function runNotify(
  workspaceId: string,
  event: WorkflowEvent,
  action: Action,
): Promise<ActionResult> {
  if (!action.userId) return { type: action.type, ok: false, detail: "Nobody to notify." };
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: action.userId, workspaceId } },
    select: { userId: true },
  });
  if (!member) {
    return { type: action.type, ok: false, detail: "That person is not in this workspace." };
  }

  await safeDeliver({
    workspaceId,
    userIds: [action.userId],
    // Reuses an existing type rather than inventing a workflow-only one: a
    // preference matrix that grows a row every time somebody writes a rule is
    // a preference matrix nobody configures.
    type: "task_due",
    title: action.message ?? "A workflow rule fired",
    body: action.message ?? null,
    href: event.leadId ? `/leads?lead=${event.leadId}` : "/",
    entityType: event.entityType,
    entityId: event.entityId,
    // One per entity per person per hour: a rule that fires on every stage
    // move must not become a bell that rings for each of them.
    discriminator: `workflow:${event.entityId}:${new Date().toISOString().slice(0, 13)}`,
  });
  return { type: action.type, ok: true, detail: "Notified" };
}

// ---- fact builders -------------------------------------------------------------

/** Everything a rule may look at, for a lead. One read, no N+1. */
export async function leadFacts(
  workspaceId: string,
  leadId: string,
): Promise<WorkflowFacts | null> {
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      stage: true,
      source: true,
      icpScore: true,
      ownerId: true,
      email: true,
      signals: true,
      customFields: true,
      company: { select: { industry: true, city: true } },
    },
  });
  if (!lead) return null;

  const facts: WorkflowFacts = {
    stage: lead.stage,
    source: lead.source,
    icpScore: lead.icpScore,
    ownerId: lead.ownerId,
    email: lead.email,
    industry: lead.company?.industry ?? null,
    city: lead.company?.city ?? null,
    signals: Array.isArray(lead.signals) ? (lead.signals as string[]) : [],
  };
  // Custom fields are addressable as `cf:<key>`, the same reference the filter
  // builder and the table columns use.
  for (const [key, value] of Object.entries(readValues(lead.customFields))) {
    facts[`cf:${key}`] = value as WorkflowFacts[string];
  }
  return facts;
}

export async function dealFacts(
  workspaceId: string,
  dealId: string,
): Promise<{ facts: WorkflowFacts; leadId: string | null } | null> {
  const db = getWorkspaceClient(workspaceId);
  const deal = await db.deal.findUnique({
    where: { id: dealId },
    select: {
      value: true,
      status: true,
      leadId: true,
      customFields: true,
      stage: { select: { name: true, key: true } },
      pipeline: { select: { name: true, key: true } },
    },
  });
  if (!deal) return null;

  const base = deal.leadId ? await leadFacts(workspaceId, deal.leadId) : null;
  const facts: WorkflowFacts = {
    ...(base ?? {}),
    dealValue: deal.value,
    dealStage: deal.stage.key,
    dealStageName: deal.stage.name,
    dealStatus: deal.status,
    pipeline: deal.pipeline.key,
  };
  for (const [key, value] of Object.entries(readValues(deal.customFields))) {
    facts[`cf:${key}`] = value as WorkflowFacts[string];
  }
  return { facts, leadId: deal.leadId };
}
