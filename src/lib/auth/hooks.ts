/**
 * Wiring the authentication core's side effects (playbook-v2 P6/2).
 *
 * `login.ts` deliberately imports nothing that needs a request context, a
 * workspace client or Redis — it is the one place a password is checked, and
 * dragging half the app into that path would make it untestable and slow. This
 * module installs the effects instead, and is imported for its side effect by
 * the server-action layer.
 *
 * Everything here is best-effort by construction: a notification that fails
 * must never be the reason somebody cannot sign in.
 */

import { prismaUnsafe, getWorkspaceClient } from "../db";
import { setAuthEventHooks } from "./login";
import { describeDevice } from "./sessions";

let installed = false;

export function installAuthHooks(): void {
  if (installed) return;
  installed = true;

  setAuthEventHooks({
    async onNewLogin(event) {
      // Imported lazily: the notification module reaches Redis for push, and
      // the login path must not pay that cost when nobody is listening.
      const { notifyNewLogin } = await import("@/modules/notifications/notify");
      await notifyNewLogin({
        workspaceId: event.workspaceId,
        userId: event.userId,
        device: describeDevice(event.userAgent),
        ip: event.ip,
        at: event.at,
      });
    },

    async onLockout(event) {
      // A login failure has no workspace of its own. The entry goes to the
      // account's first workspace, which is where an Owner would look for it;
      // an account with no membership simply produces no entry, because there
      // is no tenant to write it under.
      const membership = await prismaUnsafe.membership.findFirst({
        where: { userId: event.userId },
        orderBy: { createdAt: "asc" },
        select: { workspaceId: true },
      });
      if (!membership) return;
      await getWorkspaceClient(membership.workspaceId).auditLog.create({
        data: {
          workspaceId: membership.workspaceId,
          actorUserId: event.userId,
          action: "auth.locked_out",
          entityType: "User",
          entityId: event.userId,
          meta: {
            email: event.email,
            ip: event.ip,
            until: event.until.toISOString(),
          },
        },
      });
    },
  });
}
