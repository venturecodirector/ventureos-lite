import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { fireWorkflow, leadFacts } from "../../src/modules/workflow/engine";
import {
  onLeadStageChanged,
  processWorkflowOverdueSweep,
} from "../../src/modules/workflow/triggers";
import { ROOT_CHAIN, type Action, type Condition } from "../../src/modules/workflow/types";

/**
 * Workflow-lite against the real database (playbook-v2 P7/5).
 *
 * The matcher and the cycle rules are unit-tested. What matters here is what
 * an action actually WRITES — and above all that the email action writes a
 * DRAFT and nothing else (CLAUDE.md hard rule #2).
 */
const NAMES = ["Workflow Alpha", "Workflow Bravo"];
const USER = "wf-user-1";
let wsA = "";
let wsB = "";
let companyA = "";

const TABLES = [
  "workflowRun",
  "workflowRule",
  "notification",
  "auditLog",
  "message",
  "task",
  "activity",
  "template",
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
  await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
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
    await prismaUnsafe.company.create({
      data: { workspaceId: wsA, name: "Danubia Kft", industry: "HoReCa" },
    })
  ).id;
});

const db = () => getWorkspaceClient(wsA);

async function lead(over: Record<string, unknown> = {}) {
  return prismaUnsafe.lead.create({
    data: {
      workspaceId: wsA,
      companyId: companyA,
      contactName: "Kovács Anna",
      email: "anna@danubia.hu",
      icpScore: 4,
      signals: ["hiring"],
      ...over,
    },
  });
}

async function rule(over: {
  name?: string;
  trigger?: string;
  triggerConfig?: Record<string, unknown>;
  conditions?: Condition[];
  actions: Action[];
  enabled?: boolean;
  workspaceId?: string;
}) {
  return prismaUnsafe.workflowRule.create({
    data: {
      workspaceId: over.workspaceId ?? wsA,
      name: over.name ?? `Rule ${Math.random().toString(36).slice(2, 8)}`,
      trigger: over.trigger ?? "lead_stage_changed",
      triggerConfig: (over.triggerConfig ?? {}) as object,
      conditions: over.conditions as unknown as object[],
      actions: over.actions as unknown as object[],
      enabled: over.enabled ?? true,
    },
  });
}

async function fire(leadId: string, trigger = "lead_stage_changed") {
  const facts = await leadFacts(wsA, leadId);
  return fireWorkflow(wsA, {
    trigger: trigger as never,
    entityType: "lead",
    entityId: leadId,
    leadId,
    facts: facts!,
    chain: ROOT_CHAIN,
  });
}

describe("the email action drafts and stops (CLAUDE.md hard rule #2)", () => {
  it("writes a DRAFT message and nothing that could send it", async () => {
    const l = await lead({ stage: "REPLIED" });
    await rule({
      trigger: "lead_stage_changed",
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "draft_email", subject: "Following up", body: "Hi there," }],
    });

    expect(await fire(l.id)).toBe(1);

    const messages = await db().message.findMany({ where: { leadId: l.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("DRAFT");
    expect(messages[0].sentAt).toBeNull();
    expect(messages[0].direction).toBe("OUTBOUND");
    // Not Claude's work, so not an AI draft: the flag means something specific
    // (rule #6) and must not be borrowed.
    expect(messages[0].aiDrafted).toBe(false);
    expect(messages[0].body).toContain("Following up");

    // And nothing was queued or logged as sent.
    expect(await db().emailLog.count()).toBe(0);
  });

  it("draws the body from an email template when one is chosen", async () => {
    const template = await db().template.create({
      data: {
        workspaceId: wsA,
        type: "EMAIL",
        lang: "HU",
        name: "Follow-up",
        body: "Kedves {{client.name}},",
        status: "ACTIVE",
      },
    });
    const l = await lead({ stage: "REPLIED" });
    await rule({
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "draft_email", templateId: template.id }],
    });

    await fire(l.id);
    const message = await db().message.findFirstOrThrow({ where: { leadId: l.id } });
    expect(message.body).toContain("Kedves");
    expect(message.status).toBe("DRAFT");
  });

  it("fails the action, not the rule, when the template is gone", async () => {
    const l = await lead({ stage: "REPLIED" });
    await rule({
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "draft_email", templateId: "no-such-template" }],
    });

    await fire(l.id);
    expect(await db().message.count()).toBe(0);
    const run = await db().workflowRun.findFirstOrThrow();
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/no longer exists/);
  });
});

describe("the other actions", () => {
  it("creates a task, stamped so the queue can say why it exists", async () => {
    const l = await lead({ stage: "QUALIFIED" });
    await rule({
      triggerConfig: { stage: "QUALIFIED" },
      actions: [{ type: "create_task", title: "Send the quote", dueInDays: 2 }],
    });

    await fire(l.id);
    const task = await db().task.findFirstOrThrow();
    expect(task.title).toBe("Send the quote");
    expect(task.source).toBe("workflow");
    expect(task.entityId).toBe(l.id);
  });

  it("adds and removes a signal without duplicating one that is there", async () => {
    const l = await lead({ stage: "CONTACTED", signals: ["hiring"] });
    await rule({
      name: "add",
      triggerConfig: { stage: "CONTACTED" },
      actions: [
        { type: "add_signal", signal: "hiring" },
        { type: "add_signal", signal: "warm" },
        { type: "remove_signal", signal: "hiring" },
      ],
    });

    await fire(l.id);
    const after = await db().lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.signals).toEqual(["warm"]);
  });

  it("moves a lead to Not now WITH a wake-up date", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "move_not_now" }],
    });

    await fire(l.id);
    const after = await db().lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.stage).toBe("NOT_NOW");
    // Parked, not lost.
    expect(after.wakeUpAt).not.toBeNull();
  });

  it("refuses to notify someone outside the workspace", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "notify_user", userId: "a-stranger", message: "look" }],
    });

    await fire(l.id);
    const run = await db().workflowRun.findFirstOrThrow();
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/not in this workspace/);
    expect(await db().notification.count()).toBe(0);
  });
});

describe("matching and the log", () => {
  it("fires only for the configured stage", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      triggerConfig: { stage: "REPLIED" },
      actions: [{ type: "add_signal", signal: "x" }],
    });

    expect(await fire(l.id)).toBe(0);
    // A trigger that does not apply is not logged as a considered no-match —
    // otherwise every stage move writes a row for every rule in the workspace.
    expect(await db().workflowRun.count()).toBe(0);
  });

  it("logs a no-match, because 'why did my rule not fire' is the question", async () => {
    const l = await lead({ stage: "CONTACTED", icpScore: 1 });
    await rule({
      triggerConfig: { stage: "CONTACTED" },
      conditions: [{ field: "icpScore", operator: "gte", value: 4 }],
      actions: [{ type: "add_signal", signal: "x" }],
    });

    expect(await fire(l.id)).toBe(0);
    const run = await db().workflowRun.findFirstOrThrow();
    expect(run.status).toBe("no_match");
    expect(run.detail).toMatch(/Conditions did not match/);
  });

  it("stamps the rule VERSION on the run, so an old log is not misread", async () => {
    const l = await lead({ stage: "CONTACTED" });
    const r = await rule({
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "add_signal", signal: "one" }],
    });
    await fire(l.id);

    await prismaUnsafe.workflowRule.update({
      where: { id: r.id },
      data: { actions: [{ type: "add_signal", signal: "two" }], version: { increment: 1 } },
    });
    await fire(l.id);

    const runs = await db().workflowRun.findMany({ orderBy: { at: "asc" } });
    expect(runs.map((x) => x.ruleVersion)).toEqual([1, 2]);
  });

  it("never runs a disabled rule — the kill switch", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      enabled: false,
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "add_signal", signal: "x" }],
    });

    expect(await fire(l.id)).toBe(0);
    expect(await db().workflowRun.count()).toBe(0);
  });

  it("never runs another workspace's rules", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      workspaceId: wsB,
      triggerConfig: { stage: "CONTACTED" },
      actions: [{ type: "add_signal", signal: "leak" }],
    });

    expect(await fire(l.id)).toBe(0);
    const after = await db().lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.signals).toEqual(["hiring"]);
  });
});

describe("cycle protection, end to end", () => {
  it("does not let a rule re-trigger itself through its own action", async () => {
    // The rule moves the lead to Not now, which is a stage change, which is
    // this rule's own trigger.
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      name: "self",
      trigger: "lead_stage_changed",
      actions: [{ type: "move_not_now" }],
    });

    await onLeadStageChanged(wsA, l.id);
    // One run only — the action's own stage change does not loop back in.
    const runs = await db().workflowRun.findMany();
    expect(runs.filter((r) => r.status === "matched")).toHaveLength(1);
  });
});

describe("the overdue sweep", () => {
  it("fires for a task past the configured number of days, and not before", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      trigger: "task_overdue",
      triggerConfig: { days: 3 },
      actions: [{ type: "add_signal", signal: "chased" }],
    });

    // One day overdue: below the threshold.
    await db().task.create({
      data: {
        workspaceId: wsA,
        title: "Call back",
        entityType: "lead",
        entityId: l.id,
        dueAt: new Date(Date.now() - 86_400_000),
      },
    });
    await processWorkflowOverdueSweep();
    expect(
      (await db().lead.findUniqueOrThrow({ where: { id: l.id } })).signals,
    ).toEqual(["hiring"]);

    // Five days overdue: fires.
    await db().task.updateMany({
      where: { entityId: l.id },
      data: { dueAt: new Date(Date.now() - 5 * 86_400_000) },
    });
    await processWorkflowOverdueSweep();
    expect(
      (await db().lead.findUniqueOrThrow({ where: { id: l.id } })).signals,
    ).toEqual(["hiring", "chased"]);
  });

  it("ignores a task that is already done", async () => {
    const l = await lead({ stage: "CONTACTED" });
    await rule({
      trigger: "task_overdue",
      triggerConfig: { days: 1 },
      actions: [{ type: "add_signal", signal: "chased" }],
    });
    await db().task.create({
      data: {
        workspaceId: wsA,
        title: "Done already",
        entityType: "lead",
        entityId: l.id,
        dueAt: new Date(Date.now() - 10 * 86_400_000),
        doneAt: new Date(),
      },
    });

    await processWorkflowOverdueSweep();
    expect(await db().workflowRun.count()).toBe(0);
  });
});
