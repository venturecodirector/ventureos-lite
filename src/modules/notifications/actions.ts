"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActiveContext } from "@/lib/session";
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
  type NotificationView,
} from "./store";

/**
 * Notification-centre server actions (playbook-v2 P6/1). Thin: they resolve the
 * session and hand off to the store, which holds the rules and is tested
 * against a real database.
 */

export async function myNotifications(limit?: number): Promise<NotificationView[]> {
  const { workspaceId, userId } = await getActiveContext();
  return listNotifications(workspaceId, userId, { limit });
}

export async function myUnreadCount(): Promise<number> {
  const { workspaceId, userId } = await getActiveContext();
  return unreadCount(workspaceId, userId);
}

const idsSchema = z.array(z.string().min(1)).max(200);

export async function markNotificationsRead(raw: unknown): Promise<{ read: number }> {
  const parsed = idsSchema.safeParse(raw);
  if (!parsed.success) return { read: 0 };
  const { workspaceId, userId } = await getActiveContext();
  const read = await markRead(workspaceId, userId, parsed.data);
  if (read > 0) revalidatePath("/");
  return { read };
}

export async function markAllNotificationsRead(): Promise<{ read: number }> {
  const { workspaceId, userId } = await getActiveContext();
  const read = await markAllRead(workspaceId, userId);
  if (read > 0) revalidatePath("/");
  return { read };
}
