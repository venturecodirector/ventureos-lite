import { test, expect } from "@playwright/test";

test("home renders the app shell", async ({ page }) => {
  await page.goto("/");
  // Greeting is dynamic (active user); the workspace switcher shows the active workspace.
  await expect(page.getByRole("heading", { name: /good morning,/ })).toBeVisible();
  await expect(page.getByTestId("active-workspace")).toBeVisible();
  await expect(page.getByText("venture", { exact: false }).first()).toBeVisible();
});
