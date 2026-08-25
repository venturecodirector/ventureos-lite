import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { deliverNotification } from "../../src/modules/notifications/store";
import { countDigestableUnread } from "../../src/modules/notifications/digest";
import {
  hashEndpoint,
  isDeadSubscription,
  saveSubscription,
  removeSubscription,
  countSubscriptions,
} from "../../src/modules/notifications/push";
import { defaultChannels } from "../../src/modules/notifications/types";

/**
 * Preferences, the email-digest channel and push subscription storage
 * (playbook-v2 P6/1).
 */
const NAMES = ["Prefs Alpha"];
const EMAILS = ["prefs-fanni@iso.test"];

let ws = "";
let fanni = "";

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
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  fanni = (
    await prismaUnsafe.user.create({
      data: { email: EMAILS[0], name: "Fanni", passwordHash: "x" },
    })
  ).id;
  await prismaUnsafe.membership.create({ data: { userId: fanni, workspaceId: ws, role: "OWNER" } });
});

afterAll(async () => {
  await clean();
});

beforeEach(async () => {
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.notificationPreference.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.pushSubscription.deleteMany({ where: { workspaceId: ws } });
});

async function notify(type: string, entityId: string) {
  return deliverNotification({
    workspaceId: ws,
    userIds: [fanni],
    type: type as "callback_due",
    title: `${type} happened`,
    href: "/",
    entityId,
  });
}

describe("the email-digest channel", () => {
  const db = () => getWorkspaceClient(ws);

  it("counts unread notifications of types that default to the digest", async () => {
    // callback_due defaults emailDigest ON.
    expect(defaultChannels("callback_due").emailDigest).toBe(true);
    await notify("callback_due", "c1");
    expect(await countDigestableUnread(db(), fanni, "OWNER")).toBe(1);
  });

  it("ignores types that default OFF for the digest", async () => {
    expect(defaultChannels("reply_received").emailDigest).toBe(false);
    await notify("reply_received", "r1");
    expect(await countDigestableUnread(db(), fanni, "OWNER")).toBe(0);
  });

  it("honours a stored preference that turns the digest off", async () => {
    await notify("callback_due", "c2");
    await prismaUnsafe.notificationPreference.create({
      data: { workspaceId: ws, userId: fanni, type: "callback_due", emailDigest: false },
    });
    expect(await countDigestableUnread(db(), fanni, "OWNER")).toBe(0);
  });

  it("honours a stored preference that turns one ON that defaults off", async () => {
    await notify("reply_received", "r2");
    await prismaUnsafe.notificationPreference.create({
      data: { workspaceId: ws, userId: fanni, type: "reply_received", emailDigest: true },
    });
    expect(await countDigestableUnread(db(), fanni, "OWNER")).toBe(1);
  });

  it("counts only UNREAD ones — the digest is a catch-up, not an archive", async () => {
    await notify("callback_due", "c3");
    await prismaUnsafe.notification.updateMany({
      where: { workspaceId: ws, userId: fanni },
      data: { readAt: new Date() },
    });
    expect(await countDigestableUnread(db(), fanni, "OWNER")).toBe(0);
  });

  /**
   * `ownerOnly` now means "a seated member", the BDR included. What the flag
   * still keeps out is somebody with no membership — whose preference row can
   * easily outlive their seat.
   */
  it("does not count a restricted type for somebody with no seat", async () => {
    await prismaUnsafe.notification.create({
      data: {
        workspaceId: ws,
        userId: fanni,
        type: "proposal_pending",
        title: "left over",
        href: "/",
        dedupeKey: "proposal_pending:x:",
      },
    });
    expect(await countDigestableUnread(db(), fanni, "GUEST")).toBe(0);
    expect(await countDigestableUnread(db(), fanni, "BDR")).toBe(1);
    expect(await countDigestableUnread(db(), fanni, "OWNER")).toBe(1);
  });
});

describe("push subscription storage", () => {
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    p256dh: "key-material",
    auth: "auth-secret",
    userAgent: "Chrome on Android",
  };

  it("stores a device and counts it", async () => {
    await saveSubscription(ws, fanni, sub);
    expect(await countSubscriptions(ws, fanni)).toBe(1);
  });

  it("re-subscribing the same endpoint updates rather than duplicates", async () => {
    await saveSubscription(ws, fanni, sub);
    await saveSubscription(ws, fanni, { ...sub, p256dh: "rotated" });
    expect(await countSubscriptions(ws, fanni)).toBe(1);
    const row = await prismaUnsafe.pushSubscription.findUnique({
      where: { endpointHash: hashEndpoint(sub.endpoint) },
    });
    expect(row?.p256dh).toBe("rotated");
  });

  it("keys uniqueness on the hash, not the endpoint text", async () => {
    await saveSubscription(ws, fanni, sub);
    const row = await prismaUnsafe.pushSubscription.findUnique({
      where: { endpointHash: hashEndpoint(sub.endpoint) },
    });
    expect(row?.endpointHash).toHaveLength(64);
    expect(row?.endpoint).toBe(sub.endpoint);
  });

  it("removes a device, and removing twice is not an error", async () => {
    await saveSubscription(ws, fanni, sub);
    await removeSubscription(sub.endpoint);
    expect(await countSubscriptions(ws, fanni)).toBe(0);
    await expect(removeSubscription(sub.endpoint)).resolves.toBeUndefined();
  });

  it("treats 404 and 410 as a dead endpoint, and nothing else", () => {
    expect(isDeadSubscription(404)).toBe(true);
    expect(isDeadSubscription(410)).toBe(true);
    // Transient — the row must survive a rate limit or a server error.
    expect(isDeadSubscription(429)).toBe(false);
    expect(isDeadSubscription(500)).toBe(false);
    expect(isDeadSubscription(undefined)).toBe(false);
  });
});
