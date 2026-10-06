/**
 * Coders' Cafe starter: the real Coders' Cafe menu (prisma/coders-cafe/menu.ts,
 * 8 categories / 64 items / sizes / pizza add-ons, transcribed from the owner's
 * menu boards) plus dine-in tables T01–T10, imported into an EXISTING
 * restaurant through the same audited menu / master-data services an operator
 * uses by hand. It is the one builder for that dataset: the demo seed
 * (prisma/coders-cafe/seed.ts) and the desktop first-run / empty-menu import
 * all call it.
 *
 * Production-safe by construction:
 *  - additive only: never deletes or overwrites anything;
 *  - refuses unless the organization's menu is completely empty, so it cannot
 *    duplicate or mix into a menu the restaurant already built;
 *  - one transaction: a failure leaves the restaurant exactly as it was;
 *  - tables that already exist (same code at the outlet) are kept untouched;
 *  - no accounts, no public passwords, and QR codes are random (rotateTableQr),
 *    never the demo seed's derivable tokens — unless the caller asks for fixed
 *    tokens (the demo seed does, for its printed demo QR cards).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AccessContext } from "@/server/db/scope";
import { ConflictError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { runInTx } from "@/server/services/_workflow";
import { createMenuCategory, createMenuItem, addVariant, createModifierGroup, addModifierOption, attachModifierGroup } from "@/server/services/menu";
import { createFloor, createTable, rotateTableQr } from "@/server/services/masterData";
import { CODERS_CAFE_MENU, PIZZA_ADD_ONS } from "../../../prisma/coders-cafe/menu";

type Client = PrismaClient | Prisma.TransactionClient;

export const STARTER_TABLE_CODES = Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
export const MENU_NOT_EMPTY = "This restaurant already has a menu; the Coders' Cafe menu is only imported into an empty menu";

export type StarterResult = { categories: number; items: number; variants: number; tablesCreated: string[]; tablesKept: string[] };

/** Menu items + categories the organization holds (any state). */
export async function menuSize(db: Client, organizationId: string): Promise<number> {
  const [c, i] = await Promise.all([db.menuCategory.count({ where: { organizationId } }), db.menuItem.count({ where: { organizationId } })]);
  return c + i;
}

export async function importCodersCafeStarter(
  ctx: AccessContext,
  input: { outletId: string; tableToken?: (code: string) => string },
  db: Client,
): Promise<StarterResult> {
  assertCan(ctx, "menu.manage", input.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, input.outletId);
    if ((await menuSize(tx, ctx.organizationId)) > 0) throw new ConflictError(MENU_NOT_EMPTY);

    const addOns = await createModifierGroup(ctx, { name: PIZZA_ADD_ONS.name, minSelect: PIZZA_ADD_ONS.minSelect, maxSelect: PIZZA_ADD_ONS.maxSelect }, tx);
    for (const o of PIZZA_ADD_ONS.options) await addModifierOption(ctx, { groupId: addOns.id, name: o.name, priceDelta: o.priceDelta }, tx);
    let items = 0, variants = 0;
    for (const cat of CODERS_CAFE_MENU) {
      const c = await createMenuCategory(ctx, { name: cat.name, sortOrder: cat.sortOrder }, tx);
      for (const it of cat.items) {
        const item = await createMenuItem(ctx, { name: it.name, categoryId: c.id, price: it.price, isVeg: it.isVeg, station: "KITCHEN", description: it.description }, tx);
        for (const s of it.sizes ?? []) {
          await addVariant(ctx, { menuItemId: item.id, name: s.name, priceDelta: s.price - it.price }, tx);
          variants++;
        }
        if (it.pizzaAddOns) await attachModifierGroup(ctx, item.id, addOns.id, tx);
        items++;
      }
    }

    const existing = new Set((await tx.restaurantTable.findMany({ where: { outletId: input.outletId, code: { in: STARTER_TABLE_CODES } }, select: { code: true } })).map((t) => t.code));
    const missing = STARTER_TABLE_CODES.filter((c) => !existing.has(c));
    const tablesCreated: string[] = [];
    if (missing.length) {
      const floor = (await tx.floor.findFirst({ where: { outletId: input.outletId }, orderBy: { sortOrder: "asc" } })) ?? (await createFloor(ctx, { outletId: input.outletId, name: "Main Floor" }, tx));
      for (const code of missing) {
        const t = await createTable(ctx, { outletId: input.outletId, code, capacity: 4, floorId: floor.id }, tx);
        if (input.tableToken) await tx.restaurantTable.update({ where: { id: t.id }, data: { qrToken: input.tableToken(code) } });
        else await rotateTableQr(ctx, t.id, tx);
        tablesCreated.push(code);
      }
    }
    return { categories: CODERS_CAFE_MENU.length, items, variants, tablesCreated, tablesKept: [...existing].sort() };
  });
}
