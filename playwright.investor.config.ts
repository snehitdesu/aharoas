/**
 * Investor acceptance E2E: the real Coders' Cafe menu, Table T07's QR, owner /
 * manager / chef / customer in separate browser contexts, Razorpay (success,
 * decline + recovery) and cash, against the PRODUCTION build (`next start`).
 *
 * Isolated from the main suite: its own database (prisma/e2e-investor.db,
 * rebuilt every run by e2e/investor/prepare-db.ts: migrations + the Coders'
 * Cafe dataset only) and port. Razorpay is reached through RAZORPAY_API_BASE
 * = the emulator the spec starts (tests/support/razorpayEmulator.ts); the
 * adapter labels that mode MOCK. A run against Razorpay's real test mode is
 * e2e/razorpay-sandbox.spec.ts (needs rzp_test_ keys).
 *
 * Run: npm run build && npm run e2e:investor
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const INVESTOR_PORT = Number(process.env.INVESTOR_E2E_PORT ?? 3220);
export const EMULATOR_PORT = Number(process.env.RAZORPAY_EMULATOR_PORT ?? 3299);
export const INVESTOR_RZP = {
  keyId: "rzp_test_INVESTORE2E01",
  keySecret: "investor-e2e-key-secret-not-real",
  webhookSecret: "investor-e2e-webhook-secret-not-real",
  accountId: "acc_InvestorE2E01",
};
const DB_URL = `file:${path.join(process.cwd(), "prisma", "e2e-investor.db").replace(/\\/g, "/")}`;

export default defineConfig({
  testDir: "e2e/investor",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/.report-investor", open: "never" }]],
  outputDir: "e2e/.results-investor",
  use: { baseURL: `http://localhost:${INVESTOR_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", actionTimeout: 15_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx tsx e2e/investor/prepare-db.ts && npx next start -p ${INVESTOR_PORT}`,
    url: `http://localhost:${INVESTOR_PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: DB_URL,
      NODE_ENV: "production",
      AUTH_SECRET: "investor-e2e-auth-secret-not-a-real-production-value-0123456789",
      // Required for RAZORPAY_API_BASE (the emulator); startup logs it as a warning.
      ALLOW_MOCK_PROVIDERS: "true",
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: INVESTOR_RZP.keyId,
      RAZORPAY_KEY_SECRET: INVESTOR_RZP.keySecret,
      RAZORPAY_WEBHOOK_SECRET: INVESTOR_RZP.webhookSecret,
      RAZORPAY_API_BASE: `http://127.0.0.1:${EMULATOR_PORT}/v1`,
      RAZORPAY_ACCOUNT_ID: INVESTOR_RZP.accountId,
      PUBLIC_BASE_URL: `http://localhost:${INVESTOR_PORT}`,
    },
  },
});
