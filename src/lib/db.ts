import { PrismaClient } from "@prisma/client";
import { tenantGuard } from "./tenant-guard";

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
 * The guarded client every request/business path uses. All queries on business
 * tables are auto-scoped to `workspaceId` by the tenant guard. Extensions share
 * the base connection pool, so calling this per request is cheap.
 */
export function getWorkspaceClient(workspaceId: string) {
  if (!workspaceId) {
    throw new Error(
      "getWorkspaceClient requires a workspaceId — the tenant guard fails closed",
    );
  }
  return prismaUnsafe.$extends(tenantGuard(workspaceId));
}

export type WorkspaceClient = ReturnType<typeof getWorkspaceClient>;
