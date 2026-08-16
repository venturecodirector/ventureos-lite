import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * The notification bell and centre (playbook-v2 P6/1).
 *
 * The store's rules are proved in test/integration/notifications.test.ts. These
 * prove the surface: the badge counts, the panel lists, an item deep-links to
 * its entity and marks itself read on the way.
 */
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const EMAIL = "e2e-runner@ventureco.test";
const TAG = "e2e-notify";

let userId = "";
let workspaceId = "";

async function seed(count: number, hrefs: string[] = []) {
  await prisma.notification.deleteMany({ where: { userId, dedupeKey: { startsWith: TAG } } });
  for (let i = 0; i < count; i += 1) {
    await prisma.notification.create({
      data: {
        workspaceId,
        userId,
        type: "callback_due",
        title: `E2E notification ${i}`,
        body: `Body of notification ${i}`,
        href: hrefs[i] ?? "/calls",
        entityType: "call",
        entityId: `e2e-call-${i}`,
        dedupeKey: `${TAG}:${i}:${Date.now()}`,
      },
    });
  }
}

test.beforeAll(async () => {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  userId = user!.id;
  const membership = await prisma.membership.findFirst({ where: { userId } });
  workspaceId = membership!.workspaceId;
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId, dedupeKey: { startsWith: TAG } } });
  await prisma.$disconnect();
});

test("the badge shows the unread count and the panel lists them", async ({ page }) => {
  await seed(3);
  await page.goto("/");

  await expect(page.getByTestId("notification-bell-badge")).toHaveText("3");

  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-panel")).toBeVisible();
  await expect(page.getByTestId("notification-bell-item")).toHaveCount(3);
  await expect(page.getByTestId("notification-bell-item").first()).toContainText("E2E notification");
});

test("an empty centre says so instead of showing a blank box", async ({ page }) => {
  await prisma.notification.deleteMany({ where: { userId } });
  await page.goto("/");

  await expect(page.getByTestId("notification-bell-badge")).toHaveCount(0);
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-empty")).toBeVisible();
});

test("opening a notification deep-links to its entity and marks it read", async ({ page }) => {
  await seed(1, ["/pipeline"]);
  await page.goto("/");

  await page.getByTestId("notification-bell").click();
  await page.getByTestId("notification-bell-item").first().click();

  // Followed the stored deep link.
  await expect(page).toHaveURL(/\/pipeline$/);
  // And the badge is gone, because it was the only unread one.
  await expect(page.getByTestId("notification-bell-badge")).toHaveCount(0);

  const row = await prisma.notification.findFirst({
    where: { userId, dedupeKey: { startsWith: TAG } },
  });
  expect(row?.readAt).not.toBeNull();
});

test("mark all read clears the badge and the highlights", async ({ page }) => {
  await seed(3);
  await page.goto("/");

  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-item").first()).toHaveAttribute("data-read", "false");

  await page.getByTestId("notification-bell-mark-all").click();
  await expect(page.getByTestId("notification-bell-badge")).toHaveCount(0);
  await expect(page.getByTestId("notification-bell-item").first()).toHaveAttribute("data-read", "true");

  const unread = await prisma.notification.count({ where: { userId, readAt: null } });
  expect(unread).toBe(0);
});

test("mark all read is offered only when there is something to read", async ({ page }) => {
  await seed(2);
  await page.goto("/");
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-bell-mark-all")).toBeEnabled();

  await page.getByTestId("notification-bell-mark-all").click();
  await expect(page.getByTestId("notification-bell-mark-all")).toBeDisabled();
});

test("the bell survives a reload with the right count", async ({ page }) => {
  await seed(2);
  await page.goto("/");
  await expect(page.getByTestId("notification-bell-badge")).toHaveText("2");
  await page.reload();
  await expect(page.getByTestId("notification-bell-badge")).toHaveText("2");
});

test("the bell is reachable on a phone", async ({ page }) => {
  // CLAUDE.md: the daily loop has to work at 390px, and triage on the move is
  // exactly what a notification centre is for.
  await page.setViewportSize({ width: 390, height: 780 });
  await seed(1);
  await page.goto("/");

  const bell = page.getByTestId("notification-bell-mobile");
  await expect(bell).toBeVisible();
  const box = await bell.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(32);
  expect(box!.height).toBeGreaterThanOrEqual(32);

  await bell.click();
  await expect(page.getByTestId("notification-bell-mobile-panel")).toBeVisible();
  // The panel must not push the page sideways at 390px.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
