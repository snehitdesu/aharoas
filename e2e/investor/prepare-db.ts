/**
 * Builds the investor E2E database from scratch (prisma/e2e-investor.db):
 * the committed migration history, the Coders' Cafe dataset (real menu,
 * T01–T10, role users) and the Razorpay account binding an operator would
 * create in Settings → Integrations (webhooks are bound to the tenant by
 * Razorpay's account id). Run by playwright.investor.config.ts before
 * `next start`; dev.db is never touched.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = path.join(process.cwd(), "prisma", "e2e-investor.db");

async function main() {
  for (const s of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(DB_PATH + s)) fs.rmSync(DB_PATH + s);
  const url = `file:${DB_PATH.replace(/\\/g, "/")}`;
  process.env.DATABASE_URL = url;
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

  const { prisma } = await import("@/server/db/client");
  const { seedCodersCafe } = await import("../../prisma/coders-cafe/seed");
  const cafe = await seedCodersCafe(prisma);
  const account = process.env.RAZORPAY_ACCOUNT_ID;
  if (!account) throw new Error("RAZORPAY_ACCOUNT_ID is required (playwright.investor.config.ts)");
  await prisma.integrationConnection.create({ data: { organizationId: cafe.organizationId, outletId: cafe.outletId, kind: "PAYMENT", provider: "razorpay", externalRef: account, status: "CONNECTED", mode: "SANDBOX" } });
  console.log(`investor e2e: Coders' Cafe ${cafe.items} items, ${cafe.tables.length} tables, Razorpay account bound`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
