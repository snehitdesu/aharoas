/**
 * Builds the isolated E2E database (prisma/e2e.db) from scratch:
 *   1. force-reset the schema into prisma/e2e.db   (dev.db is never touched)
 *   2. run the real demo seed (prisma/seed.ts)
 *   3. add E2E fixtures through the REAL services (no raw inserts):
 *      - "E2E Pizza": variant + required single-choice group + optional max-2 group
 *      - customer "E2E Guest" (9999900001)
 * Run by the Playwright webServer command before `next start`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const E2E_DB_PATH = path.join(process.cwd(), "prisma", "e2e.db");
/** SQLite by default; E2E_DATABASE_URL=postgresql://… uses a (disposable!) PostgreSQL database instead. */
export const E2E_DB_URL = process.env.E2E_DATABASE_URL ?? `file:${E2E_DB_PATH.replace(/\\/g, "/")}`;
const isPostgres = E2E_DB_URL.startsWith("postgres");

async function main() {
  process.env.DATABASE_URL = E2E_DB_URL;
  const prismaCli = require.resolve("prisma/build/index.js");
  if (isPostgres) {
    execFileSync(process.execPath, [prismaCli, "db", "push", "--schema", "prisma/postgres/schema.prisma", "--force-reset", "--skip-generate", "--accept-data-loss"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: E2E_DB_URL } });
  } else {
    for (const s of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(E2E_DB_PATH + s)) fs.rmSync(E2E_DB_PATH + s);
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: E2E_DB_URL } });
  }
  const tsx = require.resolve("tsx/cli");
  // The E2E database was just reset above, so the demo seed's safety guard may be overridden.
  execFileSync(process.execPath, [tsx, "prisma/seed.ts"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: E2E_DB_URL, ALLOW_DEMO_SEED: "true" } });

  // Fixtures through the real services (imported after DATABASE_URL is set).
  const { prisma } = await import("@/server/db/client");
  const { systemContext } = await import("@/server/auth/context");
  const menu = await import("@/server/services/menu");
  const crm = await import("@/server/services/crm");
  const org = await prisma.organization.findFirstOrThrow();
  const outlets = await prisma.outlet.findMany({ where: { organizationId: org.id } });
  const ctx = systemContext(org.id, outlets.map((o) => o.id));

  const cat = await menu.createMenuCategory(ctx, { name: "Pizza", sortOrder: 99 });
  const pizza = await menu.createMenuItem(ctx, { name: "E2E Pizza", categoryId: cat.id, price: 300, taxPct: 5, station: "KITCHEN", isVeg: true, posCode: "E2E-PIZZA" });
  await menu.addVariant(ctx, { menuItemId: pizza.id, name: "Large", priceDelta: 180 });
  const crust = await menu.createModifierGroup(ctx, { name: "E2E Crust", minSelect: 1, maxSelect: 1 });
  await menu.addModifierOption(ctx, { groupId: crust.id, name: "Thin", priceDelta: 0 });
  await menu.addModifierOption(ctx, { groupId: crust.id, name: "Stuffed", priceDelta: 60 });
  const toppings = await menu.createModifierGroup(ctx, { name: "E2E Toppings", minSelect: 0, maxSelect: 2 });
  await menu.addModifierOption(ctx, { groupId: toppings.id, name: "Olive", priceDelta: 30 });
  await menu.addModifierOption(ctx, { groupId: toppings.id, name: "Jalapeno", priceDelta: 25 });
  await menu.addModifierOption(ctx, { groupId: toppings.id, name: "Corn", priceDelta: 20 });
  await menu.attachModifierGroup(ctx, pizza.id, crust.id);
  await menu.attachModifierGroup(ctx, pizza.id, toppings.id);

  await crm.createCustomer(ctx, { name: "E2E Guest", phone: "9999900001" });
  await prisma.$disconnect();
  console.log(`[e2e] database ready (${isPostgres ? "PostgreSQL" : E2E_DB_PATH})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
