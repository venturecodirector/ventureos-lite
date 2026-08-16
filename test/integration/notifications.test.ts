import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  deliverNotification,
  listNotifications,
  markAllRead,
  markRead,
  purgeExpiredNotifications,
  unreadCount,
} from "../../src/modules/notifications/store";
import { retentionCutoff } from "../../src/modules/notifications/types";

/**
 * The notification store (playbook-v2 P6/1) against the real database: who
 * receives what, the read state, dedupe, tenancy and the 90-day retention.
 */
const NAMES = ["Notif Alpha", "Notif Bravo"];
const EMAILS = ["notif-fanni@iso.test", "notif-tamas@iso.test", "notif-bob@iso.test"];

let wsA = "";
let wsB = "";
let fanni = "";
let tamas = "";
let bob = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    await prismaUnsafe.notification.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.notificationPreference.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.pushSubscription.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
  const mk = async (email: string, name: string) =>
    (await prismaUnsafe.user.create({ data: { email, name, passwordHash: "x" } })).id;
  fanni = await mk(EMAILS[0], "Fanni");
  tamas = await mk(EMAILS[1], "Tamas");
  bob = await mk(EMAILS[2], "Bob");
  await prismaUnsafe.membership.create({ data: { userId: fanni, workspaceId: wsA, role: "BDR" } });
  await prismaUnsafe.membership.create({ data: { userId: tamas, workspaceId: wsA, role: "OWNER" } });
  await prismaUnsafe.membership.create({ data: { userId: bob, workspaceId: wsB, role: "OWNER" } });
});

afterAll(async () => {
  await clean();
});

beforeEach(async () => {
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prismaUnsafe.notificationPreference.deleteMany({
    where: { workspaceId: { in: [wsA, wsB] } },
  });
});

function input(over: Partial<Parameters<typeof deliverNotification>[0]> = {}) {
  return {
    workspaceId: wsA,
    userIds: [fanni],
    type: "callback_due" as const,
    title: "Callback due — Nagy Anna",
    body: "You said you would ring back at 14:00.",
    href: "/calls",
    entityType: "call",
    entityId: "call-1",
    ...over,
  };
}

describe("delivering", () => {
  it("creates an in-app notification for each recipient", async () => {
    const res = await deliverNotification(input({ userIds: [fanni, tamas] }));
    expect(res.created).toBe(2);
    expect(await unreadCount(wsA, fanni)).toBe(1);
    expect(await unreadCount(wsA, tamas)).toBe(1);
  });

  it("carries the deep link and the entity through", async () => {
    await deliverNotification(input());
    const [n] = await listNotifications(wsA, fanni);
    expect(n.href).toBe("/calls");
    expect(n.entityType).toBe("call");
    expect(n.entityId).toBe("call-1");
    expect(n.title).toContain("Nagy Anna");
  });

  it("does not deliver the same event twice", async () => {
    await deliverNotification(input());
    const second = await deliverNotification(input());
    expect(second.created).toBe(0);
    expect(await unreadCount(wsA, fanni)).toBe(1);
  });

  it("delivers again when the event legitimately recurs", async () => {
    await deliverNotification(input({ type: "task_due", entityId: "task-1", discriminator: "2026-08-16" }));
    const next = await deliverNotification(
      input({ type: "task_due", entityId: "task-1", discriminator: "2026-08-17" }),
    );
    expect(next.created).toBe(1);
    expect(await unreadCount(wsA, fanni)).toBe(2);
  });

  it("skips a recipient who turned the type off in-app", async () => {
    await prismaUnsafe.notificationPreference.create({
      data: { workspaceId: wsA, userId: fanni, type: "callback_due", inApp: false },
    });
    const res = await deliverNotification(input());
    expect(res.created).toBe(0);
    expect(await unreadCount(wsA, fanni)).toBe(0);
  });

  it("never delivers an Owner-only type to a BDR, whatever the stored row says", async () => {
    await prismaUnsafe.notificationPreference.create({
      data: { workspaceId: wsA, userId: fanni, type: "proposal_pending", inApp: true },
    });
    const res = await deliverNotification(
      input({ type: "proposal_pending", userIds: [fanni, tamas], entityId: "prop-1" }),
    );
    // Only the Owner got it.
    expect(res.created).toBe(1);
    expect(await unreadCount(wsA, fanni)).toBe(0);
    expect(await unreadCount(wsA, tamas)).toBe(1);
  });

  it("reports which recipients want a push, without sending one", async () => {
    await prismaUnsafe.notificationPreference.create({
      data: { workspaceId: wsA, userId: tamas, type: "callback_due", inApp: true, push: true },
    });
    const res = await deliverNotification(input({ userIds: [fanni, tamas] }));
    expect(res.pushUserIds).toEqual([tamas]);
  });

  it("ignores a user who is not a member of the workspace", async () => {
    const res = await deliverNotification(input({ userIds: [bob] }));
    expect(res.created).toBe(0);
  });

  it("refuses a type it does not recognise rather than storing it", async () => {
    const res = await deliverNotification(input({ type: "meeting_cancelled" as never }));
    expect(res.created).toBe(0);
  });
});

describe("reading", () => {
  beforeEach(async () => {
    for (const i of [1, 2, 3]) {
      await deliverNotification(input({ entityId: `call-${i}` }));
    }
  });

  it("lists newest first", async () => {
    const list = await listNotifications(wsA, fanni);
    expect(list).toHaveLength(3);
    expect(list[0].createdAt.getTime()).toBeGreaterThanOrEqual(list[2].createdAt.getTime());
  });

  it("marks one read and drops the unread count", async () => {
    const [first] = await listNotifications(wsA, fanni);
    expect(await markRead(wsA, fanni, [first.id])).toBe(1);
    expect(await unreadCount(wsA, fanni)).toBe(2);
  });

  it("marks everything read", async () => {
    expect(await markAllRead(wsA, fanni)).toBe(3);
    expect(await unreadCount(wsA, fanni)).toBe(0);
  });

  it("marking read twice does not double-count", async () => {
    const [first] = await listNotifications(wsA, fanni);
    await markRead(wsA, fanni, [first.id]);
    expect(await markRead(wsA, fanni, [first.id])).toBe(0);
  });

  it("cannot mark another person's notification read", async () => {
    await deliverNotification(input({ userIds: [tamas], entityId: "call-tamas" }));
    const [tamasNote] = await listNotifications(wsA, tamas);
    expect(await markRead(wsA, fanni, [tamasNote.id])).toBe(0);
    expect(await unreadCount(wsA, tamas)).toBe(1);
  });

  it("never shows one workspace's notifications in another", async () => {
    expect(await listNotifications(wsB, fanni)).toHaveLength(0);
    expect(await unreadCount(wsB, fanni)).toBe(0);
  });
});

describe("retention", () => {
  it("deletes notifications older than 90 days and keeps the rest", async () => {
    await deliverNotification(input({ entityId: "fresh" }));
    const old = await prismaUnsafe.notification.create({
      data: {
        workspaceId: wsA,
        userId: fanni,
        type: "callback_due",
        title: "Ancient",
        href: "/calls",
        dedupeKey: "callback_due:ancient:",
        createdAt: new Date(Date.now() - 100 * 86_400_000),
      },
    });

    const removed = await purgeExpiredNotifications(retentionCutoff());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prismaUnsafe.notification.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await listNotifications(wsA, fanni)).toHaveLength(1);
  });

  it("keeps one exactly at the boundary", async () => {
    const cutoff = retentionCutoff();
    const edge = await prismaUnsafe.notification.create({
      data: {
        workspaceId: wsA,
        userId: fanni,
        type: "callback_due",
        title: "Edge",
        href: "/calls",
        dedupeKey: "callback_due:edge:",
        createdAt: new Date(cutoff.getTime() + 60_000),
      },
    });
    await purgeExpiredNotifications(cutoff);
    expect(await prismaUnsafe.notification.findUnique({ where: { id: edge.id } })).not.toBeNull();
  });
});
