import { PrismaClient } from "@prisma/client";
import { applyRls } from "../src/lib/rls";

/**
 * Apply Postgres RLS (role + grants + membership-keyed policies). Run after
 * migrations on Postgres. No-op / skip on MySQL.
 */
async function main() {
  if ((process.env.DB_FLAVOR ?? "postgres") !== "postgres") {
    console.log("DB_FLAVOR is not postgres — skipping RLS (guard-only tenancy).");
    return;
  }
  const prisma = new PrismaClient();
  try {
    await applyRls(prisma);
    console.log("Applied RLS: app_user role, grants, and membership-keyed policies.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
