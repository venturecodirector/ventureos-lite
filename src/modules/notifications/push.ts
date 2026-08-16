/**
 * Web Push over VAPID (playbook-v2 P6/1).
 *
 * The service worker at public/sw.js already had a `push` handler waiting for
 * exactly this ("used once VAPID/web-push is wired server-side"); this is the
 * server half. Nothing here is required for the product to work — with no VAPID
 * keys configured, `vapidConfigured()` is false, the settings toggle explains
 * why it is unavailable, and every notification still lands in the bell.
 */

import { createHash } from "node:crypto";
import webpush from "web-push";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { appUrl } from "@/lib/env";

export interface PushPayload {
  title: string;
  body: string | null;
  /** Where a tap should land — the service worker opens this. */
  href: string;
  tag?: string;
}

/** The endpoint's identity. A TEXT column cannot be a unique key on MySQL. */
export function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export function vapidConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/** Safe to hand to the browser — it is the public half by definition. */
export function publicVapidKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

function configure(): boolean {
  if (!vapidConfigured()) return false;
  webpush.setVapidDetails(
    // Contact for the push service if our sending misbehaves. The VAPID spec
    // accepts a mailto: OR an https: URL, so the app's own origin is a valid
    // default and avoids inventing an email variable nobody has set.
    process.env.VAPID_SUBJECT || appUrl(),
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  return true;
}

/**
 * A push service answering 404 or 410 means the subscription is GONE — the user
 * cleared site data, uninstalled the PWA, or the browser rotated it. Anything
 * else (a 429, a 500, a network blip) is transient and the row stays.
 */
export function isDeadSubscription(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

export interface PushResult {
  sent: number;
  pruned: number;
}

/**
 * Send one payload to every device these users have registered.
 *
 * Never throws: push is the least important delivery channel and the least
 * reliable, and a failed send must not take down the event that caused it.
 */
export async function sendPushToUsers(
  workspaceId: string,
  userIds: string[],
  payload: PushPayload,
): Promise<PushResult> {
  if (userIds.length === 0 || !configure()) return { sent: 0, pruned: 0 };

  const db = getWorkspaceClient(workspaceId);
  const subs = await db.pushSubscription.findMany({
    where: { userId: { in: userIds }, failedAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body ?? "",
    href: payload.href,
    tag: payload.tag,
  });

  let sent = 0;
  let pruned = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      );
      await db.pushSubscription.update({
        where: { id: sub.id },
        data: { lastUsedAt: new Date() },
      });
      sent += 1;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (isDeadSubscription(status)) {
        // Delete rather than mark: a dead endpoint will never come back, and
        // keeping it means every future send retries a known-gone device.
        await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        pruned += 1;
      } else {
        // eslint-disable-next-line no-console
        console.error("[push] send failed", status, (e as Error).message);
      }
    }
  }
  return { sent, pruned };
}

// ---- subscription storage -------------------------------------------------

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Register a device. Idempotent on the endpoint: re-subscribing the same
 * browser updates the keys rather than accumulating rows, which is what a
 * browser does on its own when it rotates them.
 */
export async function saveSubscription(
  workspaceId: string,
  userId: string,
  input: SubscriptionInput,
): Promise<void> {
  const endpointHash = hashEndpoint(input.endpoint);
  await prismaUnsafe.pushSubscription.upsert({
    where: { endpointHash },
    create: {
      workspaceId,
      userId,
      endpoint: input.endpoint,
      endpointHash,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    update: {
      // The device may have been re-registered by a different user on a shared
      // machine, so ownership follows the latest subscribe.
      workspaceId,
      userId,
      p256dh: input.p256dh,
      auth: input.auth,
      failedAt: null,
    },
  });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await prismaUnsafe.pushSubscription
    .delete({ where: { endpointHash: hashEndpoint(endpoint) } })
    .catch(() => {
      /* already gone — unsubscribing twice is not an error */
    });
}

export async function countSubscriptions(
  workspaceId: string,
  userId: string,
): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  return db.pushSubscription.count({ where: { userId, failedAt: null } });
}
