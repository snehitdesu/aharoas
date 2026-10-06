/**
 * Seed the Coders' Cafe demo / acceptance dataset (prisma/coders-cafe).
 *
 *   npm run db:seed:cafe            create it (no-op report if it already exists)
 *   npm run db:seed:cafe -- --reset delete ONLY the Coders' Cafe organization and rebuild it
 *
 * Other organizations in the database are never touched. Refused under
 * NODE_ENV=production (public demo password, derivable QR tokens) unless
 * ALLOW_DEMO_SEED=true on a disposable database.
 *
 * PUBLIC_BASE_URL (or http://localhost:3000) is used to print each table's QR link.
 */
import { prisma } from "@/server/db/client";
import { CAFE, findCafe, seedCodersCafe, cafeTableToken } from "./coders-cafe/seed";
import { UNRESOLVED } from "./coders-cafe/menu";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error("Refusing to seed demo data with NODE_ENV=production (public demo password, derivable QR tokens). Set ALLOW_DEMO_SEED=true only for a disposable database.");
  }
  const reset = process.argv.includes("--reset");
  const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const existing = await findCafe(prisma);
  if (existing && !reset) {
    console.log(`${CAFE.orgName} already exists (organization ${existing.id}). Nothing changed; use --reset to rebuild it.`);
  } else {
    const r = await seedCodersCafe(prisma, { reset });
    console.log(`${reset && existing ? "Rebuilt" : "Created"} ${CAFE.orgName}: ${r.categories} categories, ${r.items} menu items, ${r.tables.length} tables.`);
    console.log(`Not imported (unreadable on the boards): ${UNRESOLVED.length} entries, see prisma/coders-cafe/menu.ts.`);
  }
  console.log(`\nSign-in (password ${CAFE.password}): ${CAFE.users.map((u) => `${u.email} (${u.role})`).join(", ")}`);
  console.log("\nTable QR links:");
  for (const code of CAFE.tableCodes) console.log(`  ${code}  ${base}/t/${cafeTableToken(code)}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
