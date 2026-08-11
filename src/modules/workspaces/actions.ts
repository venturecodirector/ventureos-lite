"use server";

import { z } from "zod";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext, WORKSPACE_COOKIE } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { GRANTS, OWNER_GRANTS, type Grant } from "@/lib/grants";

// ---- reads (shell + settings) ---------------------------------------------

export interface WorkspaceOption {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

export interface ShellContext {
  user: { id: string; name: string; email: string; initials: string };
  activeWorkspaceId: string;
  workspaces: WorkspaceOption[];
  role: string;
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
    select: { id: true, name: true, email: true },
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
  return {
    user: {
      id: userId,
      name: user?.name ?? "User",
      email: user?.email ?? "",
      initials: initials(user?.name ?? "U"),
    },
    activeWorkspaceId: workspaceId,
    workspaces,
    role,
  };
}

export async function listMyWorkspaces(): Promise<WorkspaceOption[]> {
  return (await getShellContext()).workspaces;
}

// ---- switch (membership-validated cookie) ---------------------------------

export async function switchWorkspace(
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId } = await getActiveContext();
  const member = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!member) return { ok: false, error: "You are not a member of that workspace." };
  const c = await cookies();
  c.set(WORKSPACE_COOKIE, workspaceId, { httpOnly: true, sameSite: "lax", path: "/" });
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
    create: { email, name: name || email.split("@")[0], passwordHash: "SET_IN_AUTH_PHASE" },
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
