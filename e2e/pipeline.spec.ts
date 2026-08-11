import { test, expect } from "@playwright/test";

// Critical flow (CLAUDE.md): capture → score → gate → stage.
// Deterministic (no Claude): capture a lead manually, set its score via the
// audited override, prove the gate blocks Contacted below threshold, then allow
// it at/above threshold.
test("capture -> score -> gate -> stage", async ({ page }) => {
  const suffix = Date.now();
  const name = `E2E Lead ${suffix}`;
  const company = `E2E Co ${suffix}`;
  const email = `e2e${suffix}@example.com`;

  await page.goto("/leads");

  // Capture (manual, no AI)
  await page.getByRole("button", { name: "Add manually" }).click();
  await page.getByPlaceholder("Contact name").fill(name);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Company name *").fill(company);
  await page.getByRole("button", { name: "Add lead" }).click();

  const row = page.locator("tr", { hasText: name });
  await expect(row).toBeVisible();

  // Score below the gate (2) via the audited override
  await row.getByRole("button", { name: "Override" }).click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.getByPlaceholder("Reason (required)").fill("e2e below gate");
  await page.getByRole("button", { name: "Save override" }).click();
  await expect(row.getByRole("button", { name: /Contacted/ })).toBeVisible();

  // Gate blocks the move to Contacted
  await row.getByRole("button", { name: /Contacted/ }).click();
  await expect(page.getByText(/cannot enter Contacted/i)).toBeVisible();

  // Raise to threshold (3); the move now succeeds
  await row.getByRole("button", { name: "Override" }).click();
  await page.getByRole("button", { name: "3", exact: true }).click();
  await page.getByPlaceholder("Reason (required)").fill("e2e meets gate");
  await page.getByRole("button", { name: "Save override" }).click();
  await row.getByRole("button", { name: /Contacted/ }).click();

  // Stage advanced; the gate error is gone.
  await expect(page.locator("tr", { hasText: name })).toContainText("contacted");
  await expect(page.getByText(/cannot enter Contacted/i)).toHaveCount(0);
});
