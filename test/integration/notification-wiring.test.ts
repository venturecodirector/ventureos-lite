import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  notifyCallbackDue,
  notifyEscalation,
  notifyMeetingBooked,
  notifyProposalPending,
  notifyQuoteAccepted,
  notifyQuoteDeclined,
  notifyReplyReceived,
  notifySyncFailed,
} from "../../src/modules/notifications/notify";
import {
  dayStamp,
  processNotificationRetention,
  processTaskDueSweep,
} from "../../src/modules/notifications/jobs";

/**
 * The emitters and the sweeps (playbook-v2 P6/1): that each event reaches the
 * right PEOPLE with a working deep link, and that the two time-driven sweeps
 * behave.
 *
 * The call sites that invoke these are ordinary one-liners; what is worth
 * proving is the addressing, which is where a notification centre goes wrong.
 */
const NAMES = ["Wiring Alpha"];
const EMAILS = ["wire-fanni@iso.test", "wire-tamas@iso.test"];

let ws = "";
let fanni = "";
let tamas = "";
let ownedLead = "";
let orphanLead = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of ["notification", "notificationPreference", "task", "lead", "company"] as const) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  const mk = async (email: string, name: string) =>
    (await prismaUnsafe.user.create({ data: { email, name, passwordHash: "x" } })).id;
  fanni = await mk(EMAILS[0], "Fanni");
  tamas = await mk(EMAILS[1], "Tamas");
  await prismaUnsafe.membership.create({ data: { userId: fanni, workspaceId: ws, role: "BDR" } });
  await prismaUnsafe.membership.create({ data: { userId: tamas, workspaceId: ws, role: "OWNER" } });

  const company = await prismaUnsafe.company.create({
    data: { workspaceId: ws, name: "Danubia Kft" },
  });
  ownedLead = (
    await prismaUnsafe.lead.create({
      data: { workspaceId: ws, companyId: company.id, contactName: "Nagy Anna", ownerId: fanni },
    })
  ).id;
  orphanLead = (
    await prismaUnsafe.lead.create({
      data: { workspaceId: ws, companyId: company.id, contactName: "Unowned Ubul" },
    })
  ).id;
});

afterAll(async () => {
  await clean();
});

beforeEach(async () => {
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId: ws } });
});

const recipientsOf = async () =>
  (await prismaUnsafe.notification.findMany({ where: { workspaceId: ws }, select: { userId: true } }))
    .map((n) => n.userId)
    .sort();

const only = async () =>
  prismaUnsafe.notification.findFirst({ where: { workspaceId: ws } });

describe("a reply", () => {
  it("goes to the lead's owner alone", async () => {
    await notifyReplyReceived({ workspaceId: ws, leadId: ownedLead, threadId: "t1", snippet: "Hi" });
    expect(await recipientsOf()).toEqual([fanni]);
  });

  it("goes to everyone when nobody owns the lead", async () => {
    await notifyReplyReceived({ workspaceId: ws, leadId: orphanLead, threadId: "t2", snippet: null });
    expect(await recipientsOf()).toEqual([fanni, tamas].sort());
  });

  it("deep-links to the lead's inbox and names the contact", async () => {
    await notifyReplyReceived({ workspaceId: ws, leadId: ownedLead, threadId: "t3", snippet: "x" });
    const n = await only();
    expect(n?.href).toBe(`/inbox?lead=${ownedLead}`);
    expect(n?.title).toContain("Nagy Anna");
  });

  it("says nothing when the thread matches no lead", async () => {
    await notifyReplyReceived({ workspaceId: ws, leadId: null, threadId: "t4", snippet: "x" });
    expect(await recipientsOf()).toEqual([]);
  });

  it("treats a second message on the same thread as separate news", async () => {
    await notifyReplyReceived({ workspaceId: ws, leadId: ownedLead, threadId: "m1", snippet: "a" });
    await notifyReplyReceived({ workspaceId: ws, leadId: ownedLead, threadId: "m2", snippet: "b" });
    expect(await prismaUnsafe.notification.count({ where: { workspaceId: ws } })).toBe(2);
  });
});

describe("money-adjacent events reach the Owner as well", () => {
  it("escalation goes to the lead owner AND the Owner", async () => {
    await notifyEscalation({ workspaceId: ws, leadId: ownedLead, reason: "price" });
    expect(await recipientsOf()).toEqual([fanni, tamas].sort());
  });

  it("quote accepted goes to both, and links to the document", async () => {
    await notifyQuoteAccepted({
      workspaceId: ws,
      documentId: "doc-1",
      leadId: ownedLead,
      number: "Q-2026-01",
      acceptedBy: "Kovács Béla",
    });
    expect(await recipientsOf()).toEqual([fanni, tamas].sort());
    expect((await only())?.href).toBe("/documents/doc-1");
  });

  it("quote declined does the same", async () => {
    await notifyQuoteDeclined({
      workspaceId: ws,
      documentId: "doc-2",
      leadId: ownedLead,
      number: "Q-2026-02",
    });
    expect((await only())?.title).toContain("declined");
  });

  it("a pending proposal is Owner-only", async () => {
    await notifyProposalPending({ workspaceId: ws, count: 3 });
    expect(await recipientsOf()).toEqual([tamas]);
  });

  it("no proposals means no notification", async () => {
    await notifyProposalPending({ workspaceId: ws, count: 0 });
    expect(await recipientsOf()).toEqual([]);
  });
});

describe("a due callback", () => {
  it("goes to whoever promised it", async () => {
    await notifyCallbackDue({ workspaceId: ws, leadId: ownedLead, callId: "c1", byUserId: tamas });
    expect(await recipientsOf()).toEqual([tamas]);
    expect((await only())?.href).toBe("/calls");
  });

  it("falls back to the lead's owner when the call has no user", async () => {
    await notifyCallbackDue({ workspaceId: ws, leadId: ownedLead, callId: "c2", byUserId: null });
    expect(await recipientsOf()).toEqual([fanni]);
  });
});

describe("a booked meeting", () => {
  it("reaches the host and the Owners", async () => {
    await notifyMeetingBooked({
      workspaceId: ws,
      meetingId: "m1",
      leadId: ownedLead,
      hostUserId: fanni,
      scheduledAt: new Date("2026-09-01T09:00:00Z"),
    });
    expect(await recipientsOf()).toEqual([fanni, tamas].sort());
  });
});

describe("a broken mailbox", () => {
  it("tells only its owner, and points at the settings tab that fixes it", async () => {
    await notifySyncFailed({
      workspaceId: ws,
      accountId: "acct-1",
      userId: fanni,
      address: "fanni@ventureco.group",
      health: "reconnect_needed",
    });
    expect(await recipientsOf()).toEqual([fanni]);
    const n = await only();
    expect(n?.href).toBe("/settings?tab=email");
    expect(n?.title).toContain("Reconnect");
  });

  it("says it once a day, not once per two-minute sweep", async () => {
    for (let i = 0; i < 5; i += 1) {
      await notifySyncFailed({
        workspaceId: ws,
        accountId: "acct-1",
        userId: fanni,
        address: "fanni@ventureco.group",
        health: "error",
      });
    }
    expect(await prismaUnsafe.notification.count({ where: { workspaceId: ws } })).toBe(1);
  });
});

describe("the task-due sweep", () => {
  async function makeTask(dueAt: Date, assigneeId: string | null = fanni) {
    return prismaUnsafe.task.create({
      data: { workspaceId: ws, title: "Ring the dentist", dueAt, assigneeId },
    });
  }

  beforeEach(async () => {
    await prismaUnsafe.task.deleteMany({ where: { workspaceId: ws } });
  });

  it("notifies the assignee about a task that has come due", async () => {
    await makeTask(new Date(Date.now() - 60_000));
    expect(await processTaskDueSweep()).toBeGreaterThanOrEqual(1);
    expect(await recipientsOf()).toEqual([fanni]);
  });

  it("leaves a task due later alone", async () => {
    await makeTask(new Date(Date.now() + 86_400_000));
    await processTaskDueSweep();
    expect(await recipientsOf()).toEqual([]);
  });

  it("ignores a task already done", async () => {
    const task = await makeTask(new Date(Date.now() - 60_000));
    await prismaUnsafe.task.update({ where: { id: task.id }, data: { doneAt: new Date() } });
    await processTaskDueSweep();
    expect(await recipientsOf()).toEqual([]);
  });

  it("notifies everyone about an unassigned task, as the Today Queue shows it", async () => {
    await makeTask(new Date(Date.now() - 60_000), null);
    await processTaskDueSweep();
    expect(await recipientsOf()).toEqual([fanni, tamas].sort());
  });

  it("nags once a day, not once an hour", async () => {
    await makeTask(new Date(Date.now() - 3 * 86_400_000));
    await processTaskDueSweep();
    await processTaskDueSweep();
    await processTaskDueSweep();
    expect(await prismaUnsafe.notification.count({ where: { workspaceId: ws } })).toBe(1);
  });

  it("calls a task from a previous day overdue, and one due today merely due", async () => {
    await makeTask(new Date(Date.now() - 3 * 86_400_000));
    await processTaskDueSweep();
    expect((await only())?.title).toMatch(/^Overdue/);

    await prismaUnsafe.notification.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.task.deleteMany({ where: { workspaceId: ws } });
    // Due earlier today. The sweep's clock is passed in explicitly rather than
    // read from the wall: with an implicit `new Date()` this test failed for
    // the first five minutes of every UTC day, because 00:05 today was still
    // in the future and the task was correctly left alone.
    const today = new Date();
    today.setUTCHours(0, 5, 0, 0);
    const midday = new Date(today);
    midday.setUTCHours(12, 0, 0, 0);
    await makeTask(today);
    await processTaskDueSweep(midday);
    expect((await only())?.title).toMatch(/^Due now/);
  });

  it("stamps the day it ran, so tomorrow's pass can notify again", () => {
    expect(dayStamp(new Date("2026-08-16T23:00:00Z"))).toBe("2026-08-16");
  });
});

describe("the retention sweep", () => {
  it("removes notifications past 90 days and leaves the rest", async () => {
    await notifyEscalation({ workspaceId: ws, leadId: ownedLead, reason: "price" });
    await prismaUnsafe.notification.create({
      data: {
        workspaceId: ws,
        userId: fanni,
        type: "escalation",
        title: "Ancient",
        href: "/inbox",
        dedupeKey: "escalation:ancient:",
        createdAt: new Date(Date.now() - 120 * 86_400_000),
      },
    });

    const purged = await processNotificationRetention();
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = await prismaUnsafe.notification.findMany({ where: { workspaceId: ws } });
    expect(left.every((n) => n.title !== "Ancient")).toBe(true);
    expect(left.length).toBeGreaterThanOrEqual(1);
  });
});
