/**
 * Desktop E2E: drives the REAL Aharos desktop app (Electron main process, DB tool,
 * production Next.js standalone server, SQLite) with Playwright's Electron
 * support. Each run uses a fresh, isolated data directory (AHAROS_DATA_DIR).
 *
 *   npm run desktop:build && npm run desktop:e2e               (unpacked build)
 *   AHAROS_DESKTOP_EXE="dist-desktop/win-unpacked/Aharos.exe" npm run desktop:e2e   (packaged)
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "desktop/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "e2e/.results-desktop",
  use: { trace: "retain-on-failure", actionTimeout: 20_000 },
});
