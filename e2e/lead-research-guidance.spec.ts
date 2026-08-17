import { test, expect } from "@playwright/test";

/**
 * P1/1a+1b — a URL with no text must not offer a Claude call, and the
 * deterministic extraction must be visible before any AI runs.
 *
 * "With no text" now has one exception, and this browser is deliberately on the
 * other side of it: when the capture extension is installed, a bare profile URL
 * IS enough, because the button reads the page with the extension first and
 * then researches what it captured. There is no extension in a Playwright
 * browser, so the original rule is what applies here — which is also why the
 * disabled state below is still the honest assertion rather than a stale one.
 */
test("a bare URL gets guidance instead of a doomed research call", async ({ page }) => {
  await page.goto("/leads");
  const box = page.getByPlaceholder(/Paste a LinkedIn profile URL/i);
  await box.fill("https://www.linkedin.com/in/gabor-kovacs-1234/");

  await expect(page.getByTestId("research-guidance")).toBeVisible();
  await expect(page.getByTestId("research-button")).toBeDisabled();
});

test("pasted text yields fields with no AI, and enables research", async ({ page }) => {
  await page.goto("/leads");
  await page.getByPlaceholder(/Paste a LinkedIn profile URL/i).fill(
    "Gábor Kovács ügyvezető a Pomodoro Budapest Kft-nél. Budapest, Magyarország. " +
      "Elérhetőség: gabor@pomodorobudapest.com, +36 30 123 4567. " +
      "Weboldal: https://pomodorobudapest.com Étterem 2015 óta.",
  );

  const chips = page.getByTestId("preparse-chips");
  await expect(chips).toBeVisible();
  await expect(chips).toContainText("gabor@pomodorobudapest.com");
  await expect(chips).toContainText("+36301234567");
  await expect(chips).toContainText("Budapest");
  await expect(page.getByTestId("research-guidance")).toBeHidden();
  await expect(page.getByTestId("research-button")).toBeEnabled();
});
