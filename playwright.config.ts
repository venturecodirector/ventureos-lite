import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// The critical flows (CLAUDE.md): capture→score→gate, quote→pdf→send, workspace
// isolation, plus the auth perimeter and the outreach human-edit guardrail.
// Specs land alongside their features; this config is the harness.

/**
 * Where the run may write files, host-side.
 *
 * `.env` sets FILES_DIR=/data/files, which is the path INSIDE the app and
 * worker containers — docker-compose mounts the `files` volume there. On a
 * developer machine nothing may create `/data`, so a host-side run of the
 * isolation spec (which writes a PDF to prove workspace B cannot read
 * workspace A's) died in beforeAll with ENOENT and took the other three
 * isolation tests down with it.
 *
 * Setting it HERE rather than in `.env` is deliberate: this is evaluated in the
 * runner process before any spec loads, so specs reading `process.env.FILES_DIR`
 * see it, and `webServer` inherits it — Next.js does not overwrite a variable
 * that is already present in the environment, so `.env` cannot clobber it. The
 * container path stays exactly as it was.
 *
 * `/data/` at the repo root is already gitignored.
 */
process.env.FILES_DIR ??= resolve(__dirname, "data/files");

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
