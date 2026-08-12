import { test, expect } from "@playwright/test";

/**
 * Spec acceptance criterion 10: the daily loop is completable on a 390px phone.
 * CLAUDE.md → Responsive: bottom tab bar under 700px, 44px touch targets.
 *
 * 390px is the iPhone 14/15 logical width — the narrowest mainstream device the
 * owner is likely to hold.
 */
// Phone geometry and touch behaviour, but still Chromium — spreading a
// `devices[...]` preset would switch the browser to WebKit, which this project
// does not install.
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

const DAILY_LOOP = ["/", "/pipeline", "/inbox", "/calls"];

test("the shell switches to a bottom tab bar with reachable targets", async ({ page }) => {
  await page.goto("/");

  const sidebar = page.locator("aside").first();
  await expect(sidebar).toBeHidden();

  const tabbar = page.getByTestId("mobile-tabbar");
  await expect(tabbar).toBeVisible();

  const tabs = tabbar.locator("a, button");
  await expect(tabs).toHaveCount(5);
  for (let i = 0; i < 5; i += 1) {
    const box = await tabs.nth(i).boundingBox();
    expect(box, `tab ${i} must be laid out`).not.toBeNull();
    // 44px is the documented minimum touch target.
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test("no screen in the daily loop scrolls sideways", async ({ page }) => {
  for (const path of DAILY_LOOP) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});

test("every daily-loop screen is one tap away", async ({ page }) => {
  await page.goto("/");
  const tabbar = page.getByTestId("mobile-tabbar");

  for (const label of ["Pipeline", "Inbox", "Calls"]) {
    await tabbar.getByRole("link", { name: label }).click();
    await expect(page.getByTestId("mobile-tabbar")).toBeVisible();
    // The tapped tab marks itself current.
    await expect(
      page.getByTestId("mobile-tabbar").getByRole("link", { name: label }),
    ).toHaveAttribute("aria-current", "page");
  }
});

test("the More sheet reaches the rest of the app and closes on navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mobile-tabbar").getByRole("button", { name: "More" }).click();

  const sheet = page.getByRole("dialog", { name: "More screens" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Outreach" })).toBeVisible();

  await sheet.getByRole("link", { name: "Outreach" }).click();
  await expect(page).toHaveURL(/\/outreach/);
  await expect(page.getByRole("dialog", { name: "More screens" })).toBeHidden();
});

test("the kanban is swipeable rather than squeezed", async ({ page }) => {
  await page.goto("/pipeline");
  const board = page.locator(".snap-x").first();
  await expect(board).toBeVisible();

  const metrics = await board.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
  }));
  // Columns extend past the viewport and are reached by swiping, not by
  // shrinking every column into an unreadable sliver.
  expect(metrics.overflowX).toBe("auto");
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
});

test("the budget meter shows real spend, not a placeholder", async ({ page }) => {
  await page.goto("/");
  // The phone header renders the compact variant.
  const meter = page.getByTestId("budget-meter-mobile");
  await expect(meter).toBeVisible();
  // The old hardcoded value must never reappear.
  await expect(meter).not.toContainText("$0.84");
  await expect(meter).toContainText(/\$\d+\.\d{2}/);
});

test("the desktop sidebar rail stays absent on a phone", async ({ page }) => {
  // The rail's scroll container must not appear below the 700px breakpoint —
  // the bottom tab bar is the navigation there.
  await page.goto("/");
  await expect(page.locator("aside").first()).toBeHidden();
  await expect(page.getByTestId("sidebar-nav")).toBeHidden();
  await expect(page.getByTestId("mobile-tabbar")).toBeVisible();
});
