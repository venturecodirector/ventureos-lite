import { PrismaClient, Prisma } from "@prisma/client";
import { appUserDatabaseUrl } from "./rls";
import { getRequestUser } from "./request-user";

/**
 * The second belt: Postgres Row-Level Security, actually switched on.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 *
 * CLAUDE.md hard rule #1 promises "belt and braces" on Postgres — the Prisma
 * tenant guard AND row-level security. The policies were written, applied on
 * every deploy, and had NO EFFECT: the app connects as the database owner,
 * which is a superuser, and a superuser bypasses RLS regardless of FORCE. The
 * one function written for this — `appUserDatabaseUrl()` — was called from
 * nowhere, and nothing in the codebase ever set the session variables the
 * policies read. Verified against production before touching it: as the app's
 * own role, `select count(*) from leads` returned 73; as `app_user` with no
 * session variable, 0.
 *
 * ── HOW IT WORKS NOW ───────────────────────────────────────────────────────
 *
 * A SEPARATE connection pool as `app_user` — a role created NOSUPERUSER
 * NOBYPASSRLS — and an extension that wraps every model operation in a
 * transaction whose first statement declares the workspace:
 *
 *     SELECT set_config('app.current_workspace', $1, TRUE)
 *     <the query>
 *
 * `TRUE` makes the setting transaction-local. That is not a detail: connections
 * are pooled, so a session-level setting would leak to whichever request picked
 * up that connection next — which is the exact bug this layer exists to catch,
 * reintroduced by the thing meant to prevent it.
 *
 * ── WHAT STAYS ON THE OWNER CONNECTION ─────────────────────────────────────
 *
 * `prismaUnsafe`. It reads global tables (users, sessions, memberships) before
 * any workspace exists, and it resolves public pages by unlisted slug across
 * tenants — both legitimate, both impossible under a workspace-scoped policy.
 * It is already named "unsafe", already forbidden for business tables, and it
 * is now also the documented escape hatch from RLS.
 */

/** Off by default. A tenancy layer is switched on deliberately, not by upgrade. */
export function rlsEnabled(): boolean {
  return (process.env.DB_RLS ?? "off").toLowerCase() === "on";
}

const globalForRls = globalThis as unknown as { rlsClient: PrismaClient | undefined };

/** One pool for the whole process, like the unsafe client. */
export function getRlsClient(): PrismaClient {
  if (!globalForRls.rlsClient) {
    globalForRls.rlsClient = new PrismaClient({
      datasources: { db: { url: appUserDatabaseUrl() } },
    });
  }
  return globalForRls.rlsClient;
}

/**
 * Declare the workspace to Postgres for the duration of one query.
 *
 * Scoped to `$allModels`, so `$executeRaw` below is not itself intercepted —
 * that would recurse for ever.
 */
export function rlsScope(workspaceId: string) {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: "rls-workspace-scope",
      query: {
        $allModels: {
          async $allOperations({ args, query }) {
            const base = getRlsClient();
            // The acting user when there is one; an empty string in a
            // background job, which the policies read as "workspace only".
            const userId = getRequestUser() ?? "";
            const [, result] = await base.$transaction([
              base.$executeRaw`SELECT set_config('app.current_workspace', ${workspaceId}, TRUE), set_config('app.current_user', ${userId}, TRUE)`,
              query(args) as Prisma.PrismaPromise<unknown>,
            ]);
            return result;
          },
        },
      },
    }),
  );
}
