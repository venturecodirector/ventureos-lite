import { test as setup, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { E2E_PASSWORD } from "./helpers/auth";

/**
 * One-time sign-in whose cookies every app-facing spec reuses.
 *
 * Runs as its own Playwright project that the main project depends on, so the
 * login happens once rather than per test. Specs that need a signed-OUT browser
 * (or a different user) opt out with
 * `test.use({ storageState: { cookies: [], origins: [] } })`.
 */
const STORAGE = "e2e/.auth/state.json";
const EMAIL = "e2e-runner@ventureco.test";

setup("authenticate", async ({ page, context }) => {
  const prisma = new PrismaClient();
  try {
    const workspace =
      (await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ??
      (await prisma.workspace.create({ data: { name: "Venture CO Group" } }));

    const passwordHash = await hashPassword(E2E_PASSWORD);
    const user = await prisma.user.upsert({
      where: { email: EMAIL },
      update: {
        passwordHash,
        lockedUntil: null,
        totpEnabled: false,
        totpSecret: null,
        // The admin settings page is super-admin only, and several specs exercise
        // panels that live there. Granting it here rather than in each spec keeps
        // the gate real everywhere else: a spec that wants to prove the gate uses
        // its OWN user and does not get this.
        isSuperAdmin: true,
      },
      create: { email: EMAIL, name: "E2E Runner", passwordHash, isSuperAdmin: true },
    });
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      update: { role: "OWNER" },
      create: { userId: user.id, workspaceId: workspace.id, role: "OWNER", grants: [] },
    });
    // A previous run's throttle state must not lock this one out.
    await prisma.loginAttempt.deleteMany({ where: { email: EMAIL } });
  } finally {
    await prisma.$disconnect();
  }

  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.locator("button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await expect(page.getByTestId("active-user")).toBeVisible();

  await context.storageState({ path: STORAGE });
});
