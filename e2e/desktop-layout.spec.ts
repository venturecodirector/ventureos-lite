import { test, expect } from "@playwright/test";

/**
 * Desktop layout guarantees.
 *
 * Two regressions this pins down:
 *   - the sidebar had min-height:auto as a grid item, so it grew past the
 *     viewport (1041px tall in an 800px window) and the budget meter and
 *     profile block below it were unreachable;
 *   - analytics scaled funnel bars against the FIRST stage, so a later stage
 *     with a higher count produced a 400%-wide bar that escaped its card and
 *     drew across the rest of the page.
 */
const WIDTHS = [1280, 1512, 1920, 2560];
const PAGES = ["/", "/analytics", "/pipeline", "/leads", "/settings", "/public-pages", "/content"];

test.describe("desktop layout", () => {
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const path of PAGES) {
        await page.goto(path);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${path} at ${width}px overflows by ${overflow}px`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("the shell spans the viewport, content keeps a max width", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 900 });
    await page.goto("/analytics");

    const shellWidth = await page.evaluate(
      () => document.querySelector("aside")!.parentElement!.getBoundingClientRect().width,
    );
    expect(shellWidth).toBe(2560);

    // Content is centred and capped so lines stay readable on a wide monitor.
    const contentWidth = await page.evaluate(() => {
      const el = document.querySelector("main > div");
      return el ? el.getBoundingClientRect().width : 0;
    });
    expect(contentWidth).toBeGreaterThan(0);
    expect(contentWidth).toBeLessThanOrEqual(1400);
  });

  test("the account avatar is visible and clickable at every width", async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");

      const avatar = page.getByTestId("account-menu-button");
      await expect(avatar).toBeVisible();

      const box = await avatar.boundingBox();
      expect(box, `avatar missing at ${width}px`).not.toBeNull();
      expect(box!.x + box!.width, `avatar clipped at ${width}px`).toBeLessThanOrEqual(width);
      expect(box!.x).toBeGreaterThanOrEqual(0);

      // Actually open it — proves nothing overlaps it.
      await avatar.click();
      await expect(page.getByTestId("account-menu")).toBeVisible();
      const menu = await page.getByTestId("account-menu").boundingBox();
      expect(menu!.x + menu!.width, `menu clipped at ${width}px`).toBeLessThanOrEqual(width + 1);
      await page.keyboard.press("Escape");
    }
  });

  test("the sidebar fits the viewport, keeping the budget meter and profile reachable", async ({
    page,
  }) => {
    // A short window is the case that exposed this.
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto("/");

    const metrics = await page.evaluate(() => {
      const aside = document.querySelector("aside")!;
      const budget = document.querySelector('[data-testid="budget-meter"]')!;
      const user = document.querySelector('[data-testid="active-user"]')!;
      return {
        asideHeight: aside.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        budgetBottom: budget.getBoundingClientRect().bottom,
        userBottom: user.getBoundingClientRect().bottom,
      };
    });

    expect(metrics.asideHeight).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    expect(metrics.budgetBottom).toBeLessThanOrEqual(metrics.viewportHeight);
    expect(metrics.userBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  });

  test("analytics bars stay inside their cards", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.goto("/analytics");

    const escaped = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".rounded-card")];
      const offenders: string[] = [];
      for (const card of cards) {
        const cb = card.getBoundingClientRect();
        for (const bar of card.querySelectorAll<HTMLElement>("[style*='width']")) {
          const bb = bar.getBoundingClientRect();
          // 1px of tolerance for sub-pixel rounding.
          if (bb.right > cb.right + 1) {
            offenders.push(`${bar.className.slice(0, 40)} → ${Math.round(bb.right - cb.right)}px past`);
          }
        }
      }
      return offenders;
    });
    expect(escaped).toEqual([]);
  });
});
