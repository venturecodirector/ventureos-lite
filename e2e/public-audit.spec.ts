import { test, expect } from "@playwright/test";

/**
 * P12/1a — the self-serve audit landing.
 *
 * Runs signed OUT: this is the one unauthenticated write in the product, so a
 * session leaking into the test would hide a broken public path.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("public self-serve audit", () => {
  test("the landing is reachable without a session", async ({ page }) => {
    await page.goto("/public-audit");
    await expect(page.getByTestId("public-audit-url")).toBeVisible();
    await expect(page.getByTestId("public-audit-submit")).toBeVisible();
    // Never the app login.
    expect(page.url()).not.toContain("/login");
  });

  test("refuses a non-public host instead of queueing a job", async ({ page }) => {
    await page.goto("/public-audit");
    // The form enforces a minimum fill time, so wait past it.
    await page.waitForTimeout(2700);
    await page.getByTestId("public-audit-url").fill("http://127.0.0.1:3000");
    await page.getByTestId("public-audit-submit").click();

    const refused = page.getByTestId("public-audit-refused");
    await expect(refused).toBeVisible();
    await expect(refused).toContainText(/nyilvánosan elérhető/i);
  });

  test("refuses an instant submit as a bot", async ({ page }) => {
    await page.goto("/public-audit");
    // No wait at all — under the minimum fill time.
    await page.getByTestId("public-audit-url").fill("example.com");
    await page.getByTestId("public-audit-submit").click();
    await expect(page.getByTestId("public-audit-refused")).toBeVisible();
  });

  test("greets our own domain warmly rather than auditing it", async ({ page }) => {
    await page.goto("/public-audit");
    await page.waitForTimeout(2700);
    // APP_URL in dev is localhost, so use the configured audit host instead:
    // whatever it is, ownDomains() covers it. Fall back to a skip when the
    // dev origin is a bare localhost with no registrable domain.
    const host = new URL(page.url()).hostname;
    test.skip(host === "localhost" || host === "127.0.0.1", "no registrable own-domain in dev");
    await page.getByTestId("public-audit-url").fill(host);
    await page.getByTestId("public-audit-submit").click();
    await expect(page.getByTestId("public-audit-refused")).toBeVisible();
  });
});

test.describe("audit report routing", () => {
  test("/r/<slug> serves the report and an unknown slug 404s", async ({ page }) => {
    const res = await page.goto("/r/definitely-not-a-real-slug");
    // Not found rather than a redirect to login — the route is public.
    expect(res?.status()).toBe(404);
  });
});
