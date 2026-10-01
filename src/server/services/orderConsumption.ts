/**
 * Recipe explosion -> inventory consumption for an order.
 *
 * This is the join between sales and inventory. It is the ONLY place an order
 * depletes stock, and it is idempotent at THREE levels:
 *   1. Order.stockConsumed flag (aggregate guard).
 *   2. Unique ledger sourceRef `order:<id>:mat:<materialId>` (row guard).
 *   3. (Upstream) unique order (outlet, source, externalRef) and unique
 *      webhook (provider, eventId).
 *
 * Items whose menu item has no recipe are NOT silently dropped — they are
 * recorded in the UnmappedSale queue and raise an anomaly.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import type { AccessContext } from "@/server/db/scope";
import { getActiveVersionForMenuItem, explodeRecipe } from "@/server/services/recipe";
import { appendLedger, getAvgCost } from "@/server/services/inventory";
import { D, dMul, money } from "@/domain/money";

type Tx = Prisma.TransactionClient;

export type ConsumptionSummary = {
  consumed: boolean;
  alreadyConsumed: boolean;
  materials: Array<{ materialId: string; qty: string; cost: string }>;
  unmapped: Array<{ code: string; qty: number }>;
  totalCost: string;
};

/** Consume inventory for a settled/paid order. Safe to call more than once. */
export async function consumeInventoryForOrder(tx: Tx, ctx: AccessContext, orderId: string): Promise<ConsumptionSummary> {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.organizationId !== ctx.organizationId) throw new Error("Order not found");

  if (order.stockConsumed) {
    return { consumed: false, alreadyConsumed: true, materials: [], unmapped: [], totalCost: "0" };
  }

  const required = new Map<string, Prisma.Decimal>();
  const unmapped: Array<{ code: string; qty: number }> = [];

  for (const item of order.items) {
    const itemQty = D(item.qty);
    let version = null;
    if (item.menuItemId) version = await getActiveVersionForMenuItem(tx, ctx, item.menuItemId);

    if (!version) {
      const code = item.posItemCode ?? item.menuItemId ?? item.name;
      await recordUnmapped(tx, ctx, order.outletId, code, item.name, Number(item.qty), order.source);
      unmapped.push({ code, qty: Number(item.qty) });
      continue;
    }
    const exploded = await explodeRecipe(tx, ctx, version.id, itemQty);
    for (const [materialId, q] of exploded) {
      required.set(materialId, (required.get(materialId) ?? D(0)).plus(q));
    }
  }

  const materials: ConsumptionSummary["materials"] = [];
  let totalCost = D(0);
  for (const [materialId, q] of required) {
    const rate = await getAvgCost(tx, ctx, order.outletId, materialId);
    const row = await appendLedger(tx, ctx, {
      outletId: order.outletId,
      materialId,
      magnitude: q,
      rate,
      txnType: "SALE_CONSUMPTION",
      sourceType: "ORDER",
      sourceId: orderId,
      sourceRef: `order:${orderId}:mat:${materialId}`,
      note: `Consumption for order ${orderId}`,
    });
    const cost = money(dMul(q, rate)).abs();
    totalCost = totalCost.plus(cost);
    materials.push({ materialId, qty: q.toString(), cost: cost.toString() });
    void row;
  }

  await tx.order.update({ where: { id: orderId }, data: { stockConsumed: true } });

  return { consumed: true, alreadyConsumed: false, materials, unmapped, totalCost: money(totalCost).toString() };
}

async function recordUnmapped(tx: Tx, ctx: AccessContext, outletId: string, code: string, name: string, qty: number, source: string) {
  const existing = await tx.unmappedSale.findUnique({
    where: { outletId_source_posCode: { outletId, source, posCode: code } },
  });
  if (existing) {
    await tx.unmappedSale.update({
      where: { id: existing.id },
      data: { qty: D(existing.qty).plus(qty), lastSeenAt: new Date() },
    });
  } else {
    const sale = await tx.unmappedSale.create({
      data: { organizationId: ctx.organizationId, outletId, posCode: code, posName: name, qty: D(qty), source, status: "OPEN" },
    });
    // Raise an anomaly once, when first seen. entityId links it to the queue row
    // so the anomaly detector recognizes it and does not raise a duplicate.
    await tx.anomaly.create({
      data: {
        organizationId: ctx.organizationId,
        outletId,
        type: "UNMAPPED_ITEM",
        severity: "MEDIUM",
        entityType: "UnmappedSale",
        entityId: sale.id,
        message: `Sold item "${name}" (${code}) has no recipe mapping`,
        status: "OPEN",
      },
    });
  }
}
