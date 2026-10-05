/**
 * Unmapped-sale queue: sold items that could not be exploded into stock (no
 * menu item / no approved recipe at the time of sale). The queue row keeps the
 * sold quantity until someone resolves it:
 *
 *   OPEN -> MAPPED   the sale is tied to a menu item. For a POS/aggregator code
 *                    the item's posCode is set, so future imports map directly.
 *                    Optionally `consume`: the queued quantity is exploded
 *                    through that item's active recipe and posted ONCE as
 *                    SALE_CONSUMPTION (catch-up), so the books reflect the sales.
 *   OPEN -> IGNORED  e.g. a non-stock item (service charge, packaging fee).
 *
 * A resolved row that is sold unmapped again is reopened with only the new
 * quantity (orderConsumption.recordUnmapped). Resolution needs recipe.manage at
 * the outlet; a catch-up consumption also needs inventory.adjust. Audited.
 */
import { type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { UnmappedSaleStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, runInTx } from "@/server/services/_workflow";
import { appendLedger, getAvgCost } from "@/server/services/inventory";
import { explodeRecipe, getActiveVersionForMenuItem } from "@/server/services/recipe";
import { D, num } from "@/domain/money";

export async function listUnmappedSales(db: PrismaClient, ctx: AccessContext, input: { outletId: string; status?: string; take?: number }) {
  const f = z.object({ outletId: z.string().min(1), status: UnmappedSaleStatus.zod.optional(), take: z.coerce.number().int().positive().max(200).default(100) }).parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "inventory.view", f.outletId);
  const rows = await db.unmappedSale.findMany({
    where: { organizationId: ctx.organizationId, outletId: f.outletId, status: f.status ?? "OPEN" },
    orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
    take: f.take,
  });
  return rows.map((r) => ({ ...r, qty: num(r.qty) }));
}

const resolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("MAP"), menuItemId: z.string().min(1), consume: z.boolean().default(false), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal("IGNORE"), note: z.string().trim().min(3, "Say why this sale has no stock effect").max(500) }).strict(),
]);

export async function resolveUnmappedSale(ctx: AccessContext, saleId: string, input: z.input<typeof resolveSchema>, db: Client = prisma) {
  const data = resolveSchema.parse(input);
  return runInTx(db, async (tx) => {
    const sale = await tx.unmappedSale.findUnique({ where: { id: saleId } });
    if (!sale || sale.organizationId !== ctx.organizationId) throw new NotFoundError("Unmapped sale not found");
    assertOutletAccess(ctx, sale.outletId);
    assertCan(ctx, "recipe.manage", sale.outletId);
    if (sale.status !== "OPEN") throw new ValidationError(`This sale is already ${sale.status.toLowerCase()}`);
    const resolvedAt = new Date();
    const actor = ctx.userId === "system" ? null : ctx.userId;

    if (data.action === "IGNORE") {
      const updated = await tx.unmappedSale.update({ where: { id: saleId }, data: { status: "IGNORED", resolvedById: actor, resolvedAt } });
      await writeAudit(tx, ctx, { action: "UPDATE", entityType: "UnmappedSale", entityId: saleId, outletId: sale.outletId, before: { status: "OPEN" }, after: { status: "IGNORED", note: data.note, qty: num(sale.qty) } });
      return { sale: updated, consumed: [] as Array<{ materialId: string; qty: string }> };
    }

    const item = await tx.menuItem.findUnique({ where: { id: data.menuItemId } });
    if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Menu item not found");
    // A code that IS a menu item id (our own POS/QR sales) maps only to that item;
    // an external POS code becomes the item's posCode (unless it already has another).
    const ownItem = await tx.menuItem.findFirst({ where: { id: sale.posCode, organizationId: ctx.organizationId }, select: { id: true } });
    if (ownItem && ownItem.id !== item.id) throw new ValidationError("This sale was of a different menu item");
    if (!ownItem) {
      if (item.posCode && item.posCode !== sale.posCode) throw new ValidationError(`${item.name} is already mapped to POS code ${item.posCode}`);
      const clash = await tx.menuItem.findFirst({ where: { organizationId: ctx.organizationId, posCode: sale.posCode, id: { not: item.id } }, select: { name: true } });
      if (clash) throw new ValidationError(`POS code ${sale.posCode} is already mapped to ${clash.name}`);
      if (!item.posCode) await tx.menuItem.update({ where: { id: item.id }, data: { posCode: sale.posCode } });
    }

    const consumed: Array<{ materialId: string; qty: string }> = [];
    if (data.consume) {
      assertCan(ctx, "inventory.adjust", sale.outletId);
      const version = await getActiveVersionForMenuItem(tx, ctx, item.id);
      if (!version) throw new ValidationError(`${item.name} has no approved recipe yet — approve one, or map without consuming`);
      const exploded = await explodeRecipe(tx, ctx, version.id, D(sale.qty));
      for (const [materialId, q] of exploded) {
        if (q.lte(0)) continue;
        const rate = await getAvgCost(tx, ctx, sale.outletId, materialId);
        // Unique per resolution: a retry inside this transaction cannot double it, and
        // the OPEN -> MAPPED status guard means a row is consumed once per opening.
        await appendLedger(tx, ctx, {
          outletId: sale.outletId, materialId, magnitude: q, rate, txnType: "SALE_CONSUMPTION", sourceType: "MANUAL", sourceId: sale.id,
          sourceRef: `unmapped:${sale.id}:${sale.firstSeenAt.getTime()}:${materialId}`, note: `Catch-up consumption for ${num(sale.qty)} × ${item.name} sold unmapped`,
        });
        consumed.push({ materialId, qty: q.toString() });
      }
    }
    const updated = await tx.unmappedSale.update({ where: { id: saleId }, data: { status: "MAPPED", mappedMenuItemId: item.id, resolvedById: actor, resolvedAt } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "UnmappedSale", entityId: saleId, outletId: sale.outletId, before: { status: "OPEN" }, after: { status: "MAPPED", menuItemId: item.id, posCode: sale.posCode, consumed, note: data.note } });
    return { sale: updated, consumed };
  });
}
