import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RLS_COVERED_TABLES } from "../../src/lib/rls";

/**
 * Every workspace-scoped table has an RLS policy (playbook-v2 P6/2).
 *
 * This test exists because the list drifted. Thirteen tables — the entire email
 * sync layer, tasks, audit watches, tracked keywords, API usage — carried a
 * `workspace_id` and no policy, because nothing compared the list against the
 * schema. On Postgres that is the braces missing from the belt; on MySQL, where
 * there is no RLS at all, it makes no difference — but the list must be right
 * for the flavour where it does.
 *
 * Reads the schema rather than the generated client: the schema is the source
 * of truth, and a model added without a migration should still fail this.
 */
const SCHEMA = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");

/** Table names of every model carrying a workspaceId. */
function tenantScopedTables(): string[] {
  const out: string[] = [];
  for (const [, body] of SCHEMA.matchAll(/model \w+ \{([\s\S]*?)\n\}/g)) {
    if (!/^\s*workspaceId\s+String/m.test(body)) continue;
    const mapped = /@@map\("([^"]+)"\)/.exec(body);
    if (mapped) out.push(mapped[1]);
  }
  return out;
}

describe("RLS coverage", () => {
  it("finds a meaningful number of tenant tables, so a broken parse cannot pass", () => {
    expect(tenantScopedTables().length).toBeGreaterThan(40);
  });

  it("covers every workspace-scoped table", () => {
    const covered = new Set(RLS_COVERED_TABLES);
    const missing = tenantScopedTables().filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });

  it("claims no table that does not exist in the schema", () => {
    const known = new Set([
      ...tenantScopedTables(),
      // Global auth/tenancy tables with their own dedicated policies.
      "sessions",
      "password_reset_tokens",
      "memberships",
      "workspaces",
    ]);
    expect(RLS_COVERED_TABLES.filter((t) => !known.has(t))).toEqual([]);
  });

  it("lists each table once", () => {
    expect(new Set(RLS_COVERED_TABLES).size).toBe(RLS_COVERED_TABLES.length);
  });
});
