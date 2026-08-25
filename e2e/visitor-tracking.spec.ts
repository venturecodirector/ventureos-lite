import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * The measurement, end to end (playbook-v3 P8/a).
 *
 * The unit tests prove what the beacon is allowed to claim; this proves the
 * script actually runs on a published page, reaches the endpoint, and lands a
 * row — and that a Do-Not-Track browser leaves nothing but a count.
 */
const prisma = new PrismaClient();

test.afterAll(() => prisma.$disconnect());

test("a public page records a visit, and the notice is on the page", async ({ page }) => {
  await prisma.pageVisit.deleteMany({ where: { pageSlug: "tamas" } });

  await page.goto("/book/tamas");
  await expect(page.getByRole("heading", { name: /book a call with tamas/i })).toBeVisible();

  // The disclosure is not optional — it ships with the script.
  await expect(page.getByText(/látogatottsági adatokat gyűjt/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Részletek" })).toHaveAttribute("href", "/privacy");

  await expect
    .poll(() => prisma.pageVisit.count({ where: { pageSlug: "tamas" } }), { timeout: 15_000 })
    .toBeGreaterThan(0);

  const visit = await prisma.pageVisit.findFirst({ where: { pageSlug: "tamas" } });
  expect(visit!.pageType).toBe("booking");
  expect(visit!.doNotTrack).toBe(false);
  expect(visit!.sessionToken.length).toBeGreaterThan(4);
  // No cookie was set by any of this.
  const cookies = await page.context().cookies();
  expect(cookies.filter((c) => c.name.startsWith("vo_"))).toHaveLength(0);
});

test("a Do-Not-Track visitor leaves a count and nothing else", async ({ browser }) => {
  await prisma.pageVisit.deleteMany({ where: { pageSlug: "tamas" } });

  const context = await browser.newContext();
  // Set before any script runs, exactly as a browser preference would be.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "globalPrivacyControl", { get: () => true });
  });
  const page = await context.newPage();
  await page.goto("/book/tamas");
  await expect(page.getByRole("heading", { name: /book a call with tamas/i })).toBeVisible();

  await expect
    .poll(() => prisma.pageVisit.count({ where: { pageSlug: "tamas" } }), { timeout: 15_000 })
    .toBe(1);

  const visit = await prisma.pageVisit.findFirst({ where: { pageSlug: "tamas" } });
  expect(visit!.doNotTrack).toBe(true);
  expect(visit!.ipHash).toBeNull();
  expect(visit!.ipRaw).toBeNull();
  expect(visit!.referrer).toBeNull();
  expect(visit!.durationMs).toBe(0);
  await context.close();
});

test("the privacy page answers the questions the notice raises", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "látogatottsági mérés" })).toBeVisible();
  await expect(page.getByText(/Egyetlen sütit sem helyezünk el/)).toBeVisible();
  await expect(page.getByText(/legfeljebb 24 óráig/)).toBeVisible();
  await expect(page.getByText(/Do Not Track/)).toBeVisible();
});

test("the self-serve landing is measured too — the first step of the funnel", async ({ page }) => {
  await prisma.pageVisit.deleteMany({ where: { pageType: "audit_landing" } });

  await page.goto("/public-audit/hu");
  await expect(page.getByText(/látogatottsági adatokat gyűjt/)).toBeVisible();

  await expect
    .poll(() => prisma.pageVisit.count({ where: { pageType: "audit_landing" } }), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const visit = await prisma.pageVisit.findFirst({ where: { pageType: "audit_landing" } });
  // The locale stands in for the slug: this page has no tenant to resolve.
  expect(visit!.pageSlug).toBe("hu");
  expect(visit!.workspaceId).toBeTruthy();

  await prisma.pageVisit.deleteMany({ where: { pageType: "audit_landing" } });
});
