import { test, expect } from "@playwright/test";

/**
 * P1/1e — issuing the credential the extension needs. Shown once, because
 * only a hash is stored.
 */
test("an owner can issue and revoke a capture token", async ({ page }) => {
  await page.goto("/settings");

  await page.getByPlaceholder(/Which browser/i).fill("e2e laptop");
  await page.getByTestId("issue-capture-token").click();

  const shown = page.getByTestId("issued-token");
  await expect(shown).toBeVisible();
  await expect(shown).toContainText(/vos_cap_/);

  // It appears in the list, and can be revoked again.
  await expect(page.getByText("e2e laptop")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByText("e2e laptop")).toBeHidden({ timeout: 10_000 });
});
