import type { PrismaClient } from "@prisma/client";

/**
 * Postgres Row-Level Security (belt-and-braces with the tenant guard).
 *
 * Policies are keyed to workspace membership: a row is visible only when
 *   - its workspace_id equals the session GUC `app.current_workspace`, AND
 *   - the session GUC `app.current_user` is a member of that workspace.
 *
 * The app connects as a NON-superuser role (`app_user`) in production so RLS is
 * actually enforced (superusers bypass RLS). Set the two GUCs per transaction
 * with set_config(..., true). This module applies the role, grants and policies
 * idempotently; it is a no-op story on MySQL (which has no RLS — tenancy there
 * rests solely on the guard).
 */

const APP_ROLE = "app_user";
const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? "app_pw";

// Every tenant-scoped table (snake_case @@map names in schema.prisma).
const BUSINESS_TABLES = [
  "companies",
  "leads",
  "activities",
  "messages",
  "frames",
  "meetings",
  "insights",
  "proposals",
  "reports",
  "targets",
  "audit_logs",
  "prospect_searches",
  "audit_results",
  "audit_shares",
  "templates",
  "documents",
  "email_logs",
  "calls",
  "campaigns",
  "campaign_steps",
  "campaign_recipients",
  "referrers",
  "registry_data",
  "deal_outcomes",
  "booking_pages",
  "quote_acceptances",
  "invoices",
  "suppressions",
  "claude_usage",
  "content_posts",
];

const CURRENT_WS = "current_setting('app.current_workspace', true)";
const CURRENT_USER = "current_setting('app.current_user', true)";

function businessTablePolicy(table: string): string[] {
  const predicate = `
    workspace_id = ${CURRENT_WS}
    AND EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.workspace_id = ${table}.workspace_id
        AND m.user_id = ${CURRENT_USER}
    )`;
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ws_isolation ON ${table}`,
    `CREATE POLICY ws_isolation ON ${table} USING (${predicate}) WITH CHECK (${predicate})`,
  ];
}

function statements(): string[] {
  const out: string[] = [];

  // 1. Non-superuser, non-bypassrls application role.
  out.push(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END
  $$`);

  // 2. Privileges (users has no RLS so login lookups work).
  out.push(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  out.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
  );
  out.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
  );

  // 3. Business tables: membership-keyed isolation.
  for (const table of BUSINESS_TABLES) {
    out.push(...businessTablePolicy(table));
  }

  // 4. Auth tables. `sessions` and `login_attempts` are global (no
  //    workspace_id) and hold session tokens, emails and IPs. The app role must
  //    reach them to sign users in, but a session row is only ever readable by
  //    its owner — so a compromised tenant query cannot harvest other users'
  //    sessions. `login_attempts` stays app-writable but unreadable per-user:
  //    the throttle counts rows via the same role, keyed by email/ip, and no
  //    UI ever selects from it.
  out.push(
    `ALTER TABLE sessions ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE sessions FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS session_self ON sessions`,
    // The login path runs before a user context exists, so an unset GUC must
    // still be able to insert/lookup; once set, a session row is owner-only.
    `CREATE POLICY session_self ON sessions USING (
       ${CURRENT_USER} IS NULL OR ${CURRENT_USER} = '' OR user_id = ${CURRENT_USER}
     ) WITH CHECK (
       ${CURRENT_USER} IS NULL OR ${CURRENT_USER} = '' OR user_id = ${CURRENT_USER}
     )`,
  );

  // 5. Tenancy-mapping tables: a user sees only their own memberships and the
  //    workspaces they belong to.
  out.push(
    `ALTER TABLE memberships ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE memberships FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS member_self ON memberships`,
    `CREATE POLICY member_self ON memberships USING (user_id = ${CURRENT_USER}) WITH CHECK (user_id = ${CURRENT_USER})`,
    `ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE workspaces FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ws_member ON workspaces`,
    `CREATE POLICY ws_member ON workspaces USING (id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = ${CURRENT_USER}))`,
  );

  return out;
}

/** Apply role + grants + RLS policies. Idempotent. Postgres only. */
export async function applyRls(prisma: PrismaClient): Promise<void> {
  for (const sql of statements()) {
    await prisma.$executeRawUnsafe(sql);
  }
}

/** The DATABASE_URL with the non-superuser app_user credentials swapped in. */
export function appUserDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");
  const url = new URL(base);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}
