/**
 * Browser E2E tests against the REAL application: production build (`next start`),
 * real API routes, real services, real SQLite database (isolated prisma/e2e.db,
 * rebuilt + seeded on every run by e2e/prepare-db.ts). No API mocking except in
 * e2e/error-states.spec.ts, which deliberately injects failures.
 *
 * Run: `npm run e2e` (builds, then tests). Requires `npx playwright install chromium` once.
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);
// SQLite by default; E2E_DATABASE_URL=postgresql://… runs the same suite on PostgreSQL
// (client generated from prisma/postgres/schema.prisma; that database is force-reset).
const E2E_DB_URL = process.env.E2E_DATABASE_URL ?? `file:${path.join(process.cwd(), "prisma", "e2e.db").replace(/\\/g, "/")}`;

export default defineConfig({
  testDir: "e2e",
  // One shared server + database: run serially for deterministic state.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]],
  outputDir: "e2e/.results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, dependencies: ["setup"] },
  ],
  webServer: {
    command: `npx tsx e2e/prepare-db.ts && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    // NODE_ENV=production exercises the real build; provide a non-placeholder
    // AUTH_SECRET so production env validation (instrumentation) passes for the
    // disposable e2e deployment.
    env: { DATABASE_URL: E2E_DB_URL, NODE_ENV: "production", AUTH_SECRET: "e2e-test-auth-secret-not-a-real-production-value-0123456789" },
  },
});
