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
