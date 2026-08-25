import { PrismaClient } from "@prisma/client";
import { tenantGuard } from "./tenant-guard";
import { getRlsClient, rlsScope, rlsEnabled } from "./rls-client";

/**
 * `prismaUnsafe` is the raw, UN-scoped client. It is for:
 *   - authentication / global tables (User, Session, Membership, Workspace)
 *   - migrations, seeds, RLS setup, the anonymization job
 * Business logic MUST NOT use it for tenant tables — use getWorkspaceClient().
 */
const globalForPrisma = globalThis as unknown as {
  prismaUnsafe: PrismaClient | undefined;
};

export const prismaUnsafe = globalForPrisma.prismaUnsafe ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaUnsafe = prismaUnsafe;
}

/**
 * The guarded client every request/business path uses.
 *
 * ── TWO BELTS ──────────────────────────────────────────────────────────────
 *
 * 1. The tenant guard, always: every query on a business table is rewritten to
 *    carry `workspace_id = <this workspace>`, and every create has it forced.
 * 2. Postgres row-level security, when DB_RLS=on: the same client runs as a
 *    non-superuser role that CANNOT see another workspace's rows even if the
 *    guard were removed. See src/lib/rls-client.ts for why that was inert
 *    until now.
 *
 * The guard is applied on top of the RLS scope rather than instead of it, so
 * with RLS on, a query has to satisfy both — which is what "belt and braces"
 * was supposed to mean.
 */
export function getWorkspaceClient(workspaceId: string) {
  if (!workspaceId) {
    throw new Error(
      "getWorkspaceClient requires a workspaceId — the tenant guard fails closed",
    );
  }
  if (rlsEnabled()) {
    return getRlsClient().$extends(rlsScope(workspaceId)).$extends(tenantGuard(workspaceId));
  }
  return prismaUnsafe.$extends(tenantGuard(workspaceId));
}

export type WorkspaceClient = ReturnType<typeof getWorkspaceClient>;
