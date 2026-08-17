import { test, expect } from "@playwright/test";

test("home renders the app shell", async ({ page }) => {
  await page.goto("/");
  // The greeting carries the active user's first name and follows the DEVICE
  // clock, so which of the three it is depends on when the suite runs — this
  // test used to hardcode "good morning" and would have passed at midnight
  // while the header was wrong.
  await expect(
    page.getByRole("heading", { name: /good (morning|day|evening),/ }),
  ).toBeVisible();
  await expect(page.getByTestId("active-workspace")).toBeVisible();
  await expect(page.getByText("venture", { exact: false }).first()).toBeVisible();
});

/**
 * The sidebar wordmark, after the "LITE" badge was removed.
 *
 * The badge was a third element in a lockup that already had two, and at the
 * narrowest width a sidebar exists at (the `nav` breakpoint, 700px) it pushed
 * past the available space and wrapped. The product is "Venture OS" — there is no
 * other edition for a badge to distinguish it from.
 */
test("the sidebar lockup carries no edition badge, at any width that shows it", async ({ page }) => {
  // 700px is the narrowest desktop width: below it the sidebar is replaced by the
  // bottom tab bar, so this is the tightest the lockup ever has to fit.
  for (const width of [700, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    const sidebar = page.locator("aside").first();
    await expect(sidebar).toBeVisible();

    // The wordmark is present…
    await expect(sidebar.getByText("venture", { exact: false }).first()).toBeVisible();
    // …and nothing in it says "lite", in any casing.
    await expect(sidebar.getByText(/^lite$/i)).toHaveCount(0);
    expect(await sidebar.locator("em").count(), `em badge at ${width}px`).toBe(0);
  }
});

test("the wordmark does not wrap at the narrowest sidebar width", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/");
  const lockup = page.locator("aside").first().locator("div.font-display").first();
  await expect(lockup).toBeVisible();
  const box = await lockup.boundingBox();
  // One line of a 22px display face. Two lines would exceed ~40px, which is what
  // the badge used to cause.
  expect(box!.height).toBeLessThan(40);
});

test("the page title and PWA name are 'Venture OS', with no edition suffix", async ({ page }) => {
  await page.goto("/");
  expect(await page.title()).not.toMatch(/lite/i);

  const manifest = await page.request.get("/manifest.webmanifest");
  const body = await manifest.json();
  expect(body.name).toBe("Venture OS");
  expect(body.short_name).toBe("Venture OS");
  expect(JSON.stringify(body)).not.toMatch(/lite/i);
});
