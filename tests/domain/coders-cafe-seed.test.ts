/**
 * The Coders' Cafe dataset is deterministic, additive and resettable: a reset
 * after real trading (orders, payments, KOTs, invoices, audit) removes ONLY the
 * cafe organization's rows and rebuilds the same dataset; other organizations
 * in the database are untouched.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { createMenuItem } from "@/server/services/menu";
import { placeOrder, submitOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { seedCodersCafe, findCafe, cafeTableToken, CAFE } from "../../prisma/coders-cafe/seed";
import { menuItemCount, UNRESOLVED, CODERS_CAFE_MENU } from "../../prisma/coders-cafe/menu";

const RUN = Date.now().toString(36);
afterAll(async () => { await prisma.$disconnect(); });

describe("Coders' Cafe seed", () => {
  it("menu data is internally consistent and never includes an unresolved entry", () => {
    const names = CODERS_CAFE_MENU.flatMap((c) => c.items.map((i) => i.name));
    expect(new Set(names).size).toBe(names.length);
    expect(menuItemCount()).toBe(64);
    for (const c of CODERS_CAFE_MENU) for (const i of c.items) {
      expect(Number.isInteger(i.price) && i.price > 0, i.name).toBe(true);
      for (const s of i.sizes ?? []) expect(s.price, `${i.name} ${s.name}`).toBeGreaterThan(i.price);
      expect(i.source.length).toBeGreaterThan(0);
    }
    for (const u of UNRESOLVED) expect(names.some((n) => u.item.startsWith(n)), u.item).toBe(false);
  });

  it("reset after trading removes only the cafe's rows and rebuilds the same dataset", async () => {
    // Another tenant that must survive.
    const other = await prisma.organization.create({ data: { name: `Neighbour ${RUN}` } });
    const otherOutlet = await prisma.outlet.create({ data: { organizationId: other.id, code: `NB${RUN}`, name: "Neighbour" } });
    const otherCtx = systemContext(other.id, [otherOutlet.id]);
    const dish = await createMenuItem(otherCtx, { name: `Neighbour Dish ${RUN}`, price: 100 });
    const otherOrder = await placeOrder(otherCtx, { outletId: otherOutlet.id, channel: "TAKEAWAY", items: [{ menuItemId: dish.id, qty: 1 }] });

    const first = await seedCodersCafe(prisma, { reset: true });
    await expect(seedCodersCafe(prisma)).rejects.toThrow(/already exists/);
    // Trade at the cafe: order -> KOT -> cash payment -> invoice.
    const ctx = systemContext(first.organizationId, [first.outletId]);
    const fries = await prisma.menuItem.findFirstOrThrow({ where: { organizationId: first.organizationId, name: "Classic Fries" } });
    const o = await placeOrder(ctx, { outletId: first.outletId, channel: "DINE_IN", tableId: first.tables[6].id, items: [{ menuItemId: fries.id, qty: 2 }] });
    await submitOrder(ctx, o.id);
    const pay = await createPayment(ctx, o.id, { method: "CASH", amount: Number(o.total) });
    expect((await verifyPayment(ctx, pay.id)).orderSettled).toBe(true);
    expect(await prisma.taxInvoice.count({ where: { organizationId: first.organizationId } })).toBe(1);

    const second = await seedCodersCafe(prisma, { reset: true });
    expect(second.organizationId).not.toBe(first.organizationId);
    for (const m of ["order", "payment", "kot", "taxInvoice", "menuItem", "restaurantTable", "user", "auditLog"] as const) {
      expect(await (prisma[m] as unknown as { count(a: unknown): Promise<number> }).count({ where: { organizationId: first.organizationId } }), m).toBe(0);
    }
    expect(await prisma.organization.count({ where: { id: first.organizationId } })).toBe(0);
    expect(await prisma.order.count({ where: { organizationId: second.organizationId } })).toBe(0);
    expect(await prisma.menuItem.count({ where: { organizationId: second.organizationId } })).toBe(menuItemCount());
    expect(second.tables.map((t) => [t.code, t.token])).toEqual(CAFE.tableCodes.map((c) => [c, cafeTableToken(c)]));
    expect((await findCafe(prisma))?.id).toBe(second.organizationId);
    // The neighbour is untouched.
    expect(await prisma.order.findUnique({ where: { id: otherOrder.id } })).not.toBeNull();
    expect(await prisma.menuItem.count({ where: { organizationId: other.id } })).toBe(1);
  });
});
