import { defineConfig, devices } from "@playwright/test";

// The 3 critical flows (CLAUDE.md): capture→score→gate, quote→pdf→send,
// workspace isolation. Specs land alongside their features; this config is the
// harness. Starts the dev server for local runs.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: process.env.APP_URL ?? "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
