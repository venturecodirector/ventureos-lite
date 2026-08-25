import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * The little cards that were sliding apart.
 *
 * Both of these are measured rather than asserted on classes: the bug was never
 * a missing style, it was three rules pulling against each other (`flex-1`, a
 * minimum width and `overflow-x-auto`) producing a different layout every time
 * the container changed. Only the resulting geometry can prove that is gone.
 */
const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function widths(page: import("@playwright/test").Page, selector: string) {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().width)),
  );
}

for (const width of [390, 1280]) {
  test(`every day in the strip is the same width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/book/tamas");
    await expect(page.getByTestId("slot").first()).toBeVisible();

    const days = await widths(page, "[data-testid='day']");
    expect(days.length).toBeGreaterThan(4);
    expect(new Set(days).size, `ragged day widths: ${days.join(", ")}`).toBe(1);
    // And wide enough to read a two-digit date and a weekday.
    expect(days[0]!).toBeGreaterThanOrEqual(56);
  });
}

test("the booking page never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/book/tamas");
  await expect(page.getByTestId("slot").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page itself scrolls sideways").toBeLessThanOrEqual(1);
});

test.describe("the meetings list", () => {
  let ids: string[] = [];

  test.beforeAll(async () => {
    const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    const lead = await prisma.lead.findFirst({ where: { workspaceId: ws!.id } });
    const now = Date.now();
    ids = [];
    for (const [i, type] of ["DISCOVERY", "PROPOSAL", "FOLLOWUP"].entries()) {
      const m = await prisma.meeting.create({
        data: {
          workspaceId: ws!.id,
          lead: { connect: { id: lead!.id } },
          type,
          scheduledAt: new Date(now + (i + 1) * 86_400_000),
          durationMin: 30,
          // A long outcome is what used to make one card twice the height of
          // its neighbours.
          outcome: i === 0 ? "Megegyeztünk a folytatásban, ajánlat megy jövő héten" : null,
        },
      });
      ids.push(m.id);
    }
  });

  test.afterAll(async () => {
    await prisma.meeting.deleteMany({ where: { id: { in: ids } } });
  });

  test("cards keep the same height whatever the outcome says", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/meetings");
    const heights = await page.locator("[data-testid='meeting-card']").evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    expect(heights.length).toBeGreaterThanOrEqual(3);
    expect(new Set(heights).size, `uneven card heights: ${heights.join(", ")}`).toBe(1);
  });

  test("the brief badge never breaks in half", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/meetings");
    const badge = page.locator("[data-testid='meeting-brief-badge']").first();
    await expect(badge).toBeVisible();
    // One line: a wrapped "no" / "brief" is twice as tall as its font size.
    const box = await badge.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { h: r.height, line: parseFloat(getComputedStyle(el).fontSize) };
    });
    expect(box.h, "the badge wrapped onto two lines").toBeLessThan(box.line * 2.2);
  });

  /** The time is the host's, not UTC — the operator compares it with a calendar. */
  test("times are shown in the booking page's timezone", async ({ page }) => {
    await page.goto("/meetings");
    await expect(page.locator("[data-testid='meeting-card']").first()).not.toContainText("UTC");
  });
});
