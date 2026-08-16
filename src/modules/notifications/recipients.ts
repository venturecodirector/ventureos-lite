/**
 * Who hears about what (playbook-v2 P6/1).
 *
 * Kept apart from the emitters so the addressing rule for each kind of event is
 * stated once and can be read without wading through copy.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";

/** Owners and Admins — the approval and money audience. */
export async function workspaceOwners(workspaceId: string): Promise<string[]> {
  const rows = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: { in: ["OWNER", "ADMIN"] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

export async function allMembers(workspaceId: string): Promise<string[]> {
  const rows = await prismaUnsafe.membership.findMany({
    where: { workspaceId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * Who cares about something happening on a lead.
 *
 * Its owner, if it has one — P3/2 gave leads an owner precisely so that "your
 * lead replied" can mean something. An UNOWNED lead falls back to the whole
 * workspace: nobody having claimed it is not a reason for its reply to reach
 * nobody, and it is the same rule the Today Queue already uses for unassigned
 * tasks.
 */
export async function leadRecipients(
  workspaceId: string,
  leadId: string | null | undefined,
): Promise<string[]> {
  if (!leadId) return allMembers(workspaceId);
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { ownerId: true },
  });
  if (lead?.ownerId) return [lead.ownerId];
  return allMembers(workspaceId);
}

/** The lead owner AND the Owners — for money-adjacent events. */
export async function leadAndOwners(
  workspaceId: string,
  leadId: string | null | undefined,
): Promise<string[]> {
  const [lead, owners] = await Promise.all([
    leadRecipients(workspaceId, leadId),
    workspaceOwners(workspaceId),
  ]);
  return [...new Set([...lead, ...owners])];
}
