import { test, expect } from "@playwright/test";

// Critical flow (spec §4.21): book a slot on the public booking page end-to-end
// against the mocked calendar (dev default = MockCalendarProvider: free/busy is
// empty, createEvent returns a fake id; mock mail). Proves the day strip + slot
// grid render, bot timing check is satisfied, and a booking confirms.
test("public booking page books a slot end-to-end", async ({ page }) => {
  const suffix = Date.now();

  await page.goto("/book/tamas");

  // Venture letterhead + host header, no product chrome.
  await expect(page.getByRole("heading", { name: /book a call with tamas/i })).toBeVisible();
  await expect(page.getByText(/Europe\/Budapest/).first()).toBeVisible();

  // A day with slots is auto-selected; pick the first slot.
  const firstSlot = page.getByTestId("slot").first();
  await expect(firstSlot).toBeVisible();
  await firstSlot.click();

  // Three fields.
  await page.getByPlaceholder("Name").fill(`E2E Guest ${suffix}`);
  await page.getByPlaceholder("Company").fill(`E2E Co ${suffix}`);
  await page.getByPlaceholder("Email").fill(`e2e${suffix}@example.com`);

  // Satisfy the min-fill-time bot check (2.5s) before confirming.
  await page.waitForTimeout(2800);

  await page.getByTestId("confirm").click();

  await expect(page.getByTestId("booking-confirmed")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("booking-confirmed")).toContainText(/booked for/i);
});

// Bot protection: a too-fast submission (under the min fill time) is rejected.
test("public booking rejects a too-fast (bot) submission", async ({ page }) => {
  const suffix = Date.now();
  await page.goto("/book/tamas");

  await page.getByTestId("slot").first().click();
  await page.getByPlaceholder("Name").fill(`Bot ${suffix}`);
  await page.getByPlaceholder("Email").fill(`bot${suffix}@example.com`);

  // Confirm immediately — well under the 2.5s minimum.
  await page.getByTestId("confirm").click();

  await expect(page.getByText(/couldn't verify your submission/i)).toBeVisible();
});
