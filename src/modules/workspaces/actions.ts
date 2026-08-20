"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { setSessionWorkspace } from "@/lib/auth/sessions";
import { requireOwner } from "@/lib/authz";
import { GRANTS, OWNER_GRANTS, type Grant } from "@/lib/grants";
import { NO_PASSWORD } from "@/lib/auth/password";
import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget-status";
import { unreadCount } from "@/modules/notifications/store";
import { brandFrom, type WorkspaceBrand } from "@/modules/workspaces/brand";

// ---- reads (shell + settings) ---------------------------------------------

export interface WorkspaceOption {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

export interface ShellContext {
  user: {
    id: string;
    name: string;
    email: string;
    initials: string;
    /** Their own photo, when they have uploaded one. Initials otherwise. */
    avatarUrl: string | null;
  };
  activeWorkspaceId: string;
  workspaces: WorkspaceOption[];
  role: string;
  /** Owner reset this user's 2FA; the shell redirects to enrollment. */
  mustEnrollTotp: boolean;
  /** Today's real Claude spend vs this workspace's cap — drives the shell meter. */
  budget: BudgetStatus;
  /** Unread notifications for this user in this workspace — the bell badge. */
  unreadNotifications: number;
  /** The workspace's letterhead, for the shell wordmark. */
  brand: WorkspaceBrand;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export async function getShellContext(): Promise<ShellContext> {
  const { workspaceId, userId } = await getActiveContext();
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, mustEnrollTotp: true, avatarPath: true },
  });
  const memberships = await prismaUnsafe.membership.findMany({
    where: { userId },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const workspaces: WorkspaceOption[] = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    role: m.role,
    active: m.workspace.id === workspaceId,
  }));
  const role = memberships.find((m) => m.workspaceId === workspaceId)?.role ?? "BDR";
  const budget = await getBudgetStatus(workspaceId);
  // The shell's wordmark is the WORKSPACE's, not the product's: once someone is
  // signed in there is a workspace to brand with (audit-v2 item 6).
  const brandRow = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { brand: true },
  });
  // Server-rendered so the bell badge is right on first paint rather than
  // popping in. A count on an indexed column — cheap enough for every page.
  const unreadNotifications = await unreadCount(workspaceId, userId);
  return {
    user: {
      id: userId,
      name: user?.name ?? "User",
      email: user?.email ?? "",
      initials: initials(user?.name ?? "U"),
      // Served by id through an authenticated route; the path's hash busts the
      // cache when the photo is replaced.
      avatarUrl: user?.avatarPath ? `/api/users/${userId}/avatar` : null,
    },
    activeWorkspaceId: workspaceId,
    workspaces,
    role,
    mustEnrollTotp: user?.mustEnrollTotp ?? false,
    budget,
    unreadNotifications,
    brand: brandFrom(brandRow?.brand),
  };
}

export async function listMyWorkspaces(): Promise<WorkspaceOption[]> {
  return (await getShellContext()).workspaces;
}

// ---- switch (membership-validated, stored server-side) --------------------

/**
 * The active workspace lives on the session ROW, not in a cookie: a
 * client-writable value would be a tenancy control the client owns. Membership
 * is re-checked here and again in getActiveContext, so a stale or tampered
 * session can never read another tenant.
 */
export async function switchWorkspace(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId, sessionId } = await getActiveContext();
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!member) return { ok: false, error: "You are not a member of that workspace." };
  await setSessionWorkspace(sessionId, workspaceId);
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---- provisioning (Owner) -------------------------------------------------

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  legalName: z.string().trim().max(160).optional().default(""),
  brandColor: z.string().trim().max(20).optional().default(""),
  logoUrl: z.string().trim().max(500).optional().default(""),
  mailgunDomain: z.string().trim().max(160).optional().default(""),
  claudeBudget: z.coerce.number().min(0).max(1000).default(2),
  retentionDays: z.coerce.number().int().min(30).max(3650).default(365),
});

export async function createWorkspace(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can provision a workspace." };
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the workspace details and try again." };
  const input = parsed.data;
  const { userId } = await getActiveContext();

  const ws = await prismaUnsafe.workspace.create({
    data: {
      name: input.name,
      legalName: input.legalName || null,
      brand: { color: input.brandColor || null, logoUrl: input.logoUrl || null },
      mailgunConfig: input.mailgunDomain ? { domain: input.mailgunDomain } : undefined,
      claudeBudget: input.claudeBudget,
      retentionDays: input.retentionDays,
      // The provisioning Owner is the first member (Owner) of the new workspace.
      memberships: { create: { userId, role: "OWNER", grants: OWNER_GRANTS } },
    },
  });

  const db = getWorkspaceClient(ws.id);
  await db.auditLog.create({
    data: { workspaceId: ws.id, actorUserId: userId, action: "workspace.create", entityType: "Workspace", entityId: ws.id, meta: { name: input.name } },
  });
  revalidatePath("/settings");
  return { ok: true, id: ws.id };
}

// ---- member assignment (Owner) --------------------------------------------

const memberSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().max(120).optional().default(""),
  role: z.enum(["OWNER", "ADMIN", "BDR"]),
  grants: z.array(z.string()).default([]),
});

export async function addMember(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can assign members." };
  }
  const parsed = memberSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the member details." };
  const { email, name, role, grants } = parsed.data;
  const validGrants = grants.filter((g): g is Grant => (GRANTS as readonly string[]).includes(g));
  const { workspaceId, userId: actorId } = await getActiveContext();

  const user = await prismaUnsafe.user.upsert({
    where: { email },
    update: {},
    // No usable password: NO_PASSWORD cannot satisfy bcrypt, so the account
    // exists but cannot be signed into until an Owner sets one. That is the
    // intended flow — invites do not ship credentials.
    create: {
      email,
      name: name || email.split("@")[0],
      passwordHash: NO_PASSWORD,
      mustChangePassword: true,
    },
  });

  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    update: { role: role as Role, grants: validGrants },
    create: { userId: user.id, workspaceId, role: role as Role, grants: validGrants },
  });

  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: { workspaceId, actorUserId: actorId, action: "member.assign", entityType: "User", entityId: user.id, meta: { email, role, grants: validGrants } },
  });
  revalidatePath("/settings");
  return { ok: true };
}
