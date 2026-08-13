import { test, expect } from "@playwright/test";

/**
 * Long jobs must look alive. Audits run in the worker for tens of seconds and
 * the UI previously showed only a disabled button, so a slow run looked like a
 * timeout and people reloaded mid-job.
 */
test("an audit shows staged progress while it runs", async ({ page }) => {
  await page.goto("/audit");
  await page.getByPlaceholder("Website URL").fill("https://example.com");
  await page.getByRole("button", { name: "Run audit" }).click();

  const progress = page.getByTestId("job-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/step \d of \d/);
  // Says it is a background job rather than implying the tab must stay open.
  await expect(progress).toContainText(/PageSpeed|screenshots/i);
});
