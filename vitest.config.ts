import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Load .env so DB-backed integration tests (tenant isolation) get
// DATABASE_URL / DB_FLAVOR without a manual export. Minimal parser — no dep.
function loadDotenv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      env[key] = value;
    }
  } catch {
    // no .env — integration tests will be skipped/fail loudly if run
  }
  return env;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: loadDotenv(),
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
