import type { BrowserContext } from "@playwright/test";

/**
 * Sign a browser context in through the real login form.
 *
 * Deliberately the whole path — form, server action, bcrypt, session row,
 * Auth.js cookie — rather than injecting a cookie. E2E tests that fabricate
 * their own auth stop testing the thing most worth testing, and the previous
 * shortcut here (setting a `vos_user` cookie) is exactly the pre-auth stand-in
 * that has now been removed.
 */
export const E2E_PASSWORD = "e2e-shared-password-99";

export async function signInAs(
  context: BrowserContext,
  email: string,
  password: string = E2E_PASSWORD,
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator("button[type=submit]").click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  } finally {
    await page.close();
  }
}
