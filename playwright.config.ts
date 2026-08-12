import { defineConfig, devices } from "@playwright/test";

// The critical flows (CLAUDE.md): capture→score→gate, quote→pdf→send, workspace
// isolation, plus the auth perimeter and the outreach human-edit guardrail.
// Specs land alongside their features; this config is the harness.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    // Signs in once; the main project reuses those cookies. Specs that need a
    // signed-out browser opt out with an empty storageState.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/state.json" },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev",
    url: process.env.APP_URL ?? "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
