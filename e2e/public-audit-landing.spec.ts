import { test, expect } from "@playwright/test";

/**
 * P12 landing — the bilingual marketing page.
 *
 * Signed OUT: this is what a stranger sees. The assertions worth having are
 * that the content is SERVER-rendered (a landing page that needs JavaScript to
 * say anything is invisible to the crawlers it exists for), that both
 * languages work, and that the switch sticks.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("the Hungarian landing renders its content server-side", async ({ page }) => {
  await page.goto("/public-audit/hu");

  await expect(page.locator("h1")).toContainText("weboldala");
  // Sections, not just a form.
  await expect(page.getByText("Hogyan működik", { exact: true })).toBeVisible();
  await expect(page.getByText("Mit nézünk meg", { exact: true })).toBeVisible();
  await expect(page.getByText("Adatkezelés", { exact: true })).toBeVisible();
  await expect(page.getByText("Gyakori kérdések", { exact: true })).toBeVisible();
  await expect(page.getByTestId("public-audit-url")).toBeVisible();
});

test("the English landing renders the same page in English", async ({ page }) => {
  await page.goto("/public-audit/en");

  await expect(page.locator("h1")).toContainText("website");
  await expect(page.getByText("How it works", { exact: true })).toBeVisible();
  await expect(page.getByText("What we check", { exact: true })).toBeVisible();
  await expect(page.getByText("Questions", { exact: true })).toBeVisible();

  // No Hungarian left over from the default language.
  const body = await page.locator("main").innerText();
  expect(body).not.toContain("Hogyan működik");
});

test("marketing copy is in the HTML, not painted in by JavaScript", async ({ page }) => {
  // Fetch the raw document: this is what a crawler gets.
  const res = await page.request.get("/public-audit/hu");
  const html = await res.text();
  expect(html).toContain("Hogyan működik");
  expect(html).toContain("Gyakori kérdések");
});

test("the language switch works and is remembered", async ({ page }) => {
  await page.goto("/public-audit/hu");
  await page.getByTestId("locale-switch").click();

  await page.waitForURL(/\/(en|public-audit\/en)$/);
  await expect(page.locator("h1")).toContainText("website");

  // The cookie is what has to survive, because the root redirect consults it
  // rather than the URL you happen to be on.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "venture_lang")?.value).toBe("en");
});

test("the audit domain root picks a language from the browser", async ({ browser }) => {
  const hungarian = await browser.newContext({
    locale: "hu-HU",
    extraHTTPHeaders: { "accept-language": "hu-HU,hu;q=0.9" },
    storageState: { cookies: [], origins: [] },
  });
  const huPage = await hungarian.newPage();
  await huPage.goto("/public-audit");
  await expect(huPage).toHaveURL(/\/hu$/);
  await hungarian.close();

  const english = await browser.newContext({
    locale: "en-US",
    extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
    storageState: { cookies: [], origins: [] },
  });
  const enPage = await english.newPage();
  await enPage.goto("/public-audit");
  await expect(enPage).toHaveURL(/\/en$/);
  await english.close();
});

test("what we check lists the audit engine's real categories", async ({ page }) => {
  await page.goto("/public-audit/hu");
  // These come from CATEGORY_LABEL, not from the copy deck — the page cannot
  // advertise a check the engine does not run.
  await expect(page.getByText("Biztonság és bizalom", { exact: true })).toBeVisible();
  await expect(page.getByText("Jogi megfelelés", { exact: true })).toBeVisible();
  await expect(page.getByText("Oldalszerkezet", { exact: true })).toBeVisible();
});

test("an unknown language is a 404, not a silent fallback", async ({ page }) => {
  const res = await page.goto("/public-audit/de");
  expect(res?.status()).toBe(404);
});
