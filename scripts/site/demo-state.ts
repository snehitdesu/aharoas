/**
 * Website screenshot state. Run AFTER the demo seed, on a DISPOSABLE copy of the
 * database, to give the product screenshots a believable service in progress:
 * two weeks of settled orders (analytics), open tables (POS / captain), kitchen
 * tickets in every KDS column and a QR token on one table (guest menu).
 *
 * Everything goes through the real domain services (orders, KOTs, payments,
 * recipe consumption); only `createdAt` of past orders is moved back in time so
 * the analytics trend has history. Never point this at real data.
 *
 *   DATABASE_URL=file:/tmp/site-demo.db ALLOW_DEMO_SEED=true npx tsx scripts/site/demo-state.ts
 */
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { createOrder, addOrderItem, submitOrder } from "@/server/services/orders";
import { updateKOTStatus } from "@/server/services/kot";
import { createPayment, verifyPayment } from "@/server/services/payment";

if (process.env.ALLOW_DEMO_SEED !== "true") throw new Error("Refusing: set ALLOW_DEMO_SEED=true on a disposable database copy.");

const DAY = 86_400_000;

async function main() {
  const real = await prisma.user.count({ where: { NOT: { email: { endsWith: "@demo.local" } } } });
  if (real > 0) throw new Error("Refusing: this database has non-demo users.");

  const org = await prisma.organization.findFirstOrThrow();
  await prisma.organization.update({ where: { id: org.id }, data: { name: "Demo Restaurant Group", legalName: "Demo Restaurant" } });
  const outlet = await prisma.outlet.findFirstOrThrow({ where: { code: "HYDCEN" } });
  const ctx = systemContext(org.id, [outlet.id]);
  const menu = Object.fromEntries((await prisma.menuItem.findMany({ where: { organizationId: org.id } })).map((m) => [m.posCode, m.id]));
  const tables = await prisma.restaurantTable.findMany({ where: { outletId: outlet.id }, orderBy: { code: "asc" } });

  const basket = (seed: number): [string, number][] => {
    const pool: [string, number][][] = [
      [["M001", 2], ["M030", 3], ["M050", 2]],
      [["M010", 1], ["M032", 2], ["M040", 1], ["M052", 2]],
      [["M002", 1], ["M020", 1], ["M031", 3]],
      [["M011", 1], ["M012", 1], ["M030", 2], ["M051", 2]],
      [["M021", 1], ["M013", 1], ["M041", 1], ["M053", 2]],
      [["M003", 2], ["M060", 2]],
      [["M001", 1], ["M010", 1], ["M030", 2], ["M061", 1]],
      [["M014", 1], ["M040", 1], ["M052", 1]],
    ];
    return pool[seed % pool.length];
  };

  // 1. Fourteen days of settled orders (analytics trend, menu mix, payment split).
  let n = 0;
  for (let d = 13; d >= 1; d--) {
    const perDay = 5 + ((d * 7) % 6);
    for (let k = 0; k < perDay; k++, n++) {
      const order = await createOrder(ctx, { outletId: outlet.id, channel: k % 4 === 3 ? "TAKEAWAY" : "DINE_IN", source: "POS", covers: 2 });
      for (const [code, qty] of basket(n)) await addOrderItem(ctx, order.id, { menuItemId: menu[code], qty });
      await submitOrder(ctx, order.id);
      const kots = await prisma.kot.findMany({ where: { orderId: order.id } });
      for (const kot of kots) await prisma.kot.update({ where: { id: kot.id }, data: { status: "SERVED" } });
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const method = (["UPI", "CASH", "CARD", "UPI"] as const)[n % 4];
      const p = await createPayment(ctx, order.id, { method, amount: Number(fresh.total) });
      await verifyPayment(ctx, p.id);
      const at = new Date(Date.now() - d * DAY - (k * 47 + 30) * 60_000);
      await prisma.order.update({ where: { id: order.id }, data: { createdAt: at, paidAt: at } });
      await prisma.payment.updateMany({ where: { orderId: order.id }, data: { createdAt: at, verifiedAt: at } });
      await prisma.kot.updateMany({ where: { orderId: order.id }, data: { createdAt: at } });
    }
  }

  // 2. A service in progress: open tables with kitchen tickets in every KDS state.
  const live: { table: number; items: [string, number][]; kot: "NEW" | "ACCEPTED" | "PREPARING" | "READY" }[] = [
    { table: 0, items: [["M001", 2], ["M030", 2], ["M051", 2]], kot: "PREPARING" },
    { table: 2, items: [["M010", 1], ["M032", 3], ["M052", 1]], kot: "NEW" },
    { table: 3, items: [["M020", 1], ["M011", 1], ["M040", 1]], kot: "READY" },
    { table: 5, items: [["M002", 2], ["M031", 4]], kot: "ACCEPTED" },
    { table: 7, items: [["M013", 1], ["M041", 2], ["M053", 2]], kot: "PREPARING" },
    { table: 8, items: [["M003", 1], ["M060", 2]], kot: "NEW" },
  ];
  for (const l of live) {
    const t = tables[l.table];
    if (!t) continue;
    const order = await createOrder(ctx, { outletId: outlet.id, channel: "DINE_IN", source: "POS", tableId: t.id, covers: 2 + (l.table % 3) });
    for (const [code, qty] of l.items) await addOrderItem(ctx, order.id, { menuItemId: menu[code], qty });
    await submitOrder(ctx, order.id);
    const kots = await prisma.kot.findMany({ where: { orderId: order.id } });
    const path = { NEW: [], ACCEPTED: ["ACCEPTED"], PREPARING: ["ACCEPTED", "PREPARING"], READY: ["ACCEPTED", "PREPARING", "READY"] }[l.kot] as ("ACCEPTED" | "PREPARING" | "READY")[];
    for (const kot of kots) for (const s of path) await updateKOTStatus(ctx, kot.id, s);
  }

  // Older seed tickets would otherwise crowd the kitchen display.
  const liveOrderIds = (await prisma.order.findMany({ where: { outletId: outlet.id, status: { notIn: ["PAID", "REFUNDED", "CANCELLED"] } }, select: { id: true } })).map((o) => o.id);
  await prisma.kot.updateMany({ where: { outletId: outlet.id, orderId: { notIn: liveOrderIds }, status: { not: "SERVED" } }, data: { status: "SERVED" } });

  // Menu items without a recipe raise one "unmapped" anomaly per sale in this demo
  // catalog; keep only the seed's example so the dashboard reads like a real day.
  await prisma.anomaly.updateMany({ where: { organizationId: org.id, type: "UNMAPPED_ITEM", status: "OPEN", NOT: { message: { contains: "ZZ999" } } }, data: { status: "DISMISSED", resolutionNote: "demo data" } });

  // 3. A QR token for the guest-menu screenshot.
  const qrTable = tables[10] ?? tables[tables.length - 1];
  await prisma.restaurantTable.update({ where: { id: qrTable.id }, data: { qrToken: "site-demo-table-qr" } });
  console.log(`settled ${n} past orders, ${live.length} live tables, QR table ${qrTable.code} -> /t/site-demo-table-qr`);
}

main().finally(() => prisma.$disconnect());
