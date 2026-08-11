import { Prisma } from "@prisma/client";

/**
 * Mandatory Prisma tenant guard (CLAUDE.md hard rule #1).
 *
 * A client extension that auto-scopes every business-table query to a single
 * workspace. It:
 *   - injects `workspace_id = <session>` into the `where` of every read,
 *     update and delete (relying on Prisma's extendedWhereUnique so even
 *     findUnique/update/delete-by-id are constrained — a cross-tenant id
 *     returns null / throws P2025);
 *   - forces `workspace_id = <session>` into the `data` of every create,
 *     overriding any caller-supplied value (no smuggling rows across tenants);
 *   - fails closed: no workspace id -> throw.
 *
 * Global identity/tenancy tables carry no workspace_id and are passed through
 * untouched. Raw queries bypass this guard entirely and are banned by lint
 * (.eslintrc.json) — CLAUDE.md forbids raw queries on business tables.
 */

// Global tables (no workspace_id). Everything else is guarded by default, so a
// newly added business model is tenant-scoped unless it is deliberately global.
const UNGUARDED_MODELS = new Set<string>([
  "User",
  "Session",
  "Membership",
  "Workspace",
  "GoogleCredential",
]);

type AnyArgs = Record<string, unknown>;

function withWorkspaceWhere(args: AnyArgs, workspaceId: string): AnyArgs {
  const where = (args.where as AnyArgs | undefined) ?? {};
  return { ...args, where: { ...where, workspaceId } };
}

function scope(
  operation: string,
  rawArgs: AnyArgs | undefined,
  workspaceId: string,
): AnyArgs {
  const args: AnyArgs = rawArgs ? { ...rawArgs } : {};

  switch (operation) {
    case "create": {
      const data = (args.data as AnyArgs | undefined) ?? {};
      return { ...args, data: { ...data, workspaceId } };
    }
    case "createMany":
    case "createManyAndReturn": {
      const data = args.data;
      return {
        ...args,
        data: Array.isArray(data)
          ? data.map((row) => ({ ...(row as AnyArgs), workspaceId }))
          : { ...((data as AnyArgs | undefined) ?? {}), workspaceId },
      };
    }
    case "upsert": {
      const where = (args.where as AnyArgs | undefined) ?? {};
      const create = (args.create as AnyArgs | undefined) ?? {};
      return {
        ...args,
        where: { ...where, workspaceId },
        create: { ...create, workspaceId },
      };
    }
    default:
      // findUnique(OrThrow), findFirst(OrThrow), findMany, count, aggregate,
      // groupBy, update(Many), delete(Many): constrain by workspace_id.
      return withWorkspaceWhere(args, workspaceId);
  }
}

export function tenantGuard(workspaceId: string) {
  if (!workspaceId) {
    throw new Error("tenantGuard: a workspaceId is required (fails closed)");
  }
  return Prisma.defineExtension({
    name: "tenant-guard",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (UNGUARDED_MODELS.has(model)) {
            return query(args);
          }
          return query(scope(operation, args as AnyArgs, workspaceId));
        },
      },
    },
  });
}
