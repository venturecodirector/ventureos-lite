import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

/**
 * Authentication as the perimeter (CLAUDE.md → Auth). These run against the
 * real app: the point is that an unauthenticated browser cannot see tenant data
 * and that a signed-out session stops working immediately.
 */
// These specs manage their own sessions — start from a signed-out browser.
test.use({ storageState: { cookies: [], origins: [] } });
// One shared fixture user whose sessions these tests revoke: run them in order,
// in a single worker, so they cannot pull the session out from under each other.
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const EMAIL = "e2e-auth@ventureco.test";
// Used to prove the "unknown account" message matches; its failed attempts
// accumulate across runs and would eventually trip the throttle, so it is
// cleaned alongside EMAIL.
const UNKNOWN_EMAIL = "nobody-at-all@ventureco.test";
const PASSWORD = "e2e-password-that-is-long";

test.beforeAll(async () => {
  await prisma.loginAttempt.deleteMany({ where: { email: { in: [EMAIL, UNKNOWN_EMAIL] } } });
  const existing = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (existing) {
    await prisma.session.deleteMany({ where: { userId: existing.id } });
    await prisma.membership.deleteMany({ where: { userId: existing.id } });
    await prisma.user.delete({ where: { id: existing.id } });
  }
  const ws =
    (await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await prisma.workspace.create({ data: { name: "E2E Auth WS" } }));
  const user = await prisma.user.create({
    data: { email: EMAIL, name: "E2E Auth", passwordHash: await hashPassword(PASSWORD) },
  });
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    update: { role: "OWNER" },
    create: { userId: user.id, workspaceId: ws.id, role: "OWNER", grants: [] },
  });
});

test.afterAll(async () => {
  const u = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (u) {
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.membership.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  await prisma.loginAttempt.deleteMany({ where: { email: { in: [EMAIL, UNKNOWN_EMAIL] } } });
  await prisma.$disconnect();
});

test("an unauthenticated visitor cannot reach the app and lands on login", async ({ page }) => {
  await page.goto("/pipeline");
  await expect(page).toHaveURL(/\/login\?next=%2Fpipeline/);
  await expect(page.getByText("Sign in to continue")).toBeVisible();
  // No tenant data leaked into the login page.
  await expect(page.locator('[data-testid="active-user"]')).toHaveCount(0);
});

test("the public prospect surfaces stay reachable without a session", async ({ page }) => {
  // /share/<slug> is a public audit report; an unknown slug 404s rather than
  // redirecting to login — proof it is not behind the auth gate.
  const res = await page.goto("/share/definitely-not-a-real-slug");
  expect(res?.status()).toBe(404);
  await expect(page).not.toHaveURL(/\/login/);
});

test("signing in reaches the requested page, and signing out revokes access", async ({ page }) => {
  await page.goto("/leads");
  await expect(page).toHaveURL(/\/login/);

  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("button[type=submit]").click();

  await expect(page).toHaveURL(/\/leads/, { timeout: 15_000 });
  await expect(page.locator('[data-testid="active-user"]')).toContainText("E2E Auth");

  // Revoking the DB session must lock the browser out on its very next request,
  // even though it still holds a valid, correctly-signed cookie.
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  await prisma.session.updateMany({
    where: { userId: user!.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await page.goto("/leads");
  await expect(page).toHaveURL(/\/login/);
});

test("a wrong password is refused with a message that does not identify the account", async ({
  page,
}) => {
  await page.goto("/login");
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").fill("wrong-password-entirely");
  await page.locator("button[type=submit]").click();

  const error = page.locator('[data-testid="login-error"]');
  await expect(error).toBeVisible({ timeout: 15_000 });
  const knownAccountMessage = await error.textContent();

  // The same message for an address that does not exist at all.
  await page.goto("/login");
  await page.locator("#email").fill(UNKNOWN_EMAIL);
  await page.locator("#password").fill("wrong-password-entirely");
  await page.locator("button[type=submit]").click();
  await expect(error).toBeVisible({ timeout: 15_000 });
  expect(await error.textContent()).toBe(knownAccountMessage);
});
