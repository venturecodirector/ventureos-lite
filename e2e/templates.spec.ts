import { test, expect } from "@playwright/test";

/**
 * The template editor was fully built — quote, contract, certificate and email
 * bodies, HU/EN, live preview — and had no nav entry, so none of it was
 * reachable. These pin down the way in and the type switching, since the
 * "missing email template editor" was really a missing link.
 */
test.describe("template editors", () => {
  test("are reachable from the sidebar", async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: "Templates" });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/templates$/);
  });

  test("switch between document types and the email templates", async ({ page }) => {
    await page.goto("/templates");

    const body = page.locator("textarea").first();
    await expect(body).toBeVisible();
    const quoteBody = await body.inputValue();
    expect(quoteBody.length).toBeGreaterThan(0);

    // EMAIL is the one the operator could not get to at all.
    await page.getByRole("button", { name: "Email", exact: true }).click();
    await expect
      .poll(async () => (await body.inputValue()) !== quoteBody, {
        message: "switching to the Email template should load a different body",
      })
      .toBe(true);
    const emailBody = await body.inputValue();
    expect(emailBody.length).toBeGreaterThan(0);

    // And back to a document type.
    await page.getByRole("button", { name: "Contract", exact: true }).click();
    await expect
      .poll(async () => {
        const v = await body.inputValue();
        return v !== emailBody && v.length > 0;
      })
      .toBe(true);
  });

  test("switch language", async ({ page }) => {
    await page.goto("/templates");
    const body = page.locator("textarea").first();
    const hu = await body.inputValue();

    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect.poll(async () => (await body.inputValue()) !== hu).toBe(true);
  });
});
