import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { safeDeliver } from "@/modules/notifications/notify";
import { leadRecipients } from "@/modules/notifications/recipients";

/**
 * Recording an open or a click (playbook-v3 P9/1).
 *
 * Cross-tenant by necessity: the request arrives from a recipient's mail client
 * with nothing but the token, so the workspace is resolved FROM the token and
 * everything after that goes through the guarded client for it.
 */

/** A document number in a subject — what makes a cover email worth a bell. */
const DOCUMENT_SUBJECT = /\b(AJ|SZ|TIG)-\d{4}-\d+/i;

export interface TrackedMessage {
  id: string;
  workspaceId: string;
  leadId: string | null;
  subject: string | null;
  links: string[];
}

export async function messageForToken(token: string): Promise<TrackedMessage | null> {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const msg = await prismaUnsafe.emailMessage.findUnique({
    where: { trackingId: token },
    select: {
      id: true,
      workspaceId: true,
      subject: true,
      trackedLinks: true,
      thread: { select: { leadId: true } },
    },
  });
  if (!msg) return null;
  const links = Array.isArray(msg.trackedLinks) ? (msg.trackedLinks as string[]) : [];
  return {
    id: msg.id,
    workspaceId: msg.workspaceId,
    leadId: msg.thread?.leadId ?? null,
    subject: msg.subject,
    links,
  };
}

/**
 * Record the event. Never throws — a mail client asking for an image must get
 * its image whatever happens here.
 */
export async function recordTrackEvent(
  msg: TrackedMessage,
  kind: "open" | "click",
  url?: string,
): Promise<void> {
  const db = getWorkspaceClient(msg.workspaceId);

  const already = await db.emailTrackEvent.count({
    where: { messageId: msg.id, kind: "open" },
  });

  await db.emailTrackEvent.create({
    data: {
      workspaceId: msg.workspaceId,
      messageId: msg.id,
      leadId: msg.leadId,
      kind,
      url: url ?? null,
    },
  });

  /**
   * The bell rings for the FIRST open of a document cover email, and for
   * nothing else.
   *
   * The playbook is explicit about why: notifying on every open trains people
   * to ignore the notification, and the one that matters is "they are looking
   * at the quote right now". A click always matters — somebody chose to act.
   */
  const isFirstOpen = kind === "open" && already === 0;
  const aboutADocument = DOCUMENT_SUBJECT.test(msg.subject ?? "");
  if (!msg.leadId) return;
  if (!(kind === "click" || (isFirstOpen && aboutADocument))) return;

  await safeDeliver({
    workspaceId: msg.workspaceId,
    userIds: await leadRecipients(msg.workspaceId, msg.leadId),
    type: "visitor_signal",
    title:
      kind === "click"
        ? `Rákattintottak a levélben lévő linkre — ${msg.subject ?? "levél"}`
        : `Megnyitás jelzés — ${msg.subject ?? "levél"}`,
    body:
      kind === "click"
        ? url ?? null
        : "Első megnyitás. A jelzés tájékoztató: a képblokkolás és az Apple Mail előtöltése mindkét irányban torzít.",
    href: `/inbox?lead=${msg.leadId}`,
    entityType: "lead",
    entityId: msg.leadId,
    discriminator: `mailtrack:${msg.id}:${kind}${kind === "click" ? `:${url ?? ""}` : ""}`,
  });
}
