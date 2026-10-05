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
 *
 * Variants and modifiers (Phase 3):
 *  - a variant's consumptionFactor scales the item's recipe (Half = 0.5 ×);
 *  - a stock-linked modifier option adds its material (materialQty in unitId,
 *    converted to the base unit) per unit ordered — independent of the variant
 *    and of whether the item itself has a recipe.
 * The variant/option is looked up when the order settles (current menu values).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import type { AccessContext } from "@/server/db/scope";
import { getActiveVersionForMenuItem, explodeRecipe, convertToBase } from "@/server/services/recipe";
import { appendLedger, getAvgCost } from "@/server/services/inventory";
import { raiseAnomaly } from "@/server/services/anomaly";
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
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { modifiers: true } } } });
  if (!order || order.organizationId !== ctx.organizationId) throw new Error("Order not found");

  if (order.stockConsumed) {
    return { consumed: false, alreadyConsumed: true, materials: [], unmapped: [], totalCost: "0" };
  }

  const required = new Map<string, Prisma.Decimal>();
  const unmapped: Array<{ code: string; qty: number }> = [];

  const add = (materialId: string, q: Prisma.Decimal) => required.set(materialId, (required.get(materialId) ?? D(0)).plus(q));

  for (const item of order.items) {
    const itemQty = D(item.qty);

    // Stock-consuming add-ons first: they apply whether or not the item has a recipe.
    const optionIds = item.modifiers.map((m) => m.optionId).filter((x): x is string => Boolean(x));
    if (optionIds.length) {
      const options = await tx.modifierOption.findMany({ where: { id: { in: optionIds }, organizationId: ctx.organizationId } });
      for (const o of options) {
        if (!o.materialId || o.materialQty === null) continue;
        const perUnit = await convertToBase(tx, ctx, o.materialId, D(o.materialQty), o.unitId);
        add(o.materialId, perUnit.times(itemQty));
      }
    }

    let version = null;
    if (item.menuItemId) version = await getActiveVersionForMenuItem(tx, ctx, item.menuItemId);

    if (!version) {
      const code = item.posItemCode ?? item.menuItemId ?? item.name;
      await recordUnmapped(tx, ctx, order.outletId, code, item.name, Number(item.qty), order.source);
      unmapped.push({ code, qty: Number(item.qty) });
      continue;
    }
    let factor = D(1);
    if (item.variantId) {
      const variant = await tx.menuItemVariant.findUnique({ where: { id: item.variantId }, select: { organizationId: true, consumptionFactor: true } });
      if (variant && variant.organizationId === ctx.organizationId) factor = D(variant.consumptionFactor);
    }
    const exploded = await explodeRecipe(tx, ctx, version.id, itemQty.times(factor));
    for (const [materialId, q] of exploded) add(materialId, q);
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
  if (existing && existing.status === "OPEN") {
    await tx.unmappedSale.update({
      where: { id: existing.id },
      data: { qty: D(existing.qty).plus(qty), lastSeenAt: new Date() },
    });
  } else if (existing) {
    // Resolved before (mapped / ignored) yet sold unmapped again: back on the
    // queue with only the new quantity (the old one was already dealt with).
    await tx.unmappedSale.update({
      where: { id: existing.id },
      data: { status: "OPEN", qty: D(qty), firstSeenAt: new Date(), lastSeenAt: new Date(), resolvedById: null, resolvedAt: null, mappedMenuItemId: null },
    });
    // Deduplicated: reuses a still-open anomaly for this queue row.
    await raiseAnomaly(tx, ctx, { type: "UNMAPPED_ITEM", severity: "MEDIUM", outletId, entityType: "UnmappedSale", entityId: existing.id, message: `Sold item "${name}" (${code}) has no recipe mapping`, recurrence: "WHILE_UNRESOLVED", evidenceAt: new Date() });
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
