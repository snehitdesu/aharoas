/**
 * Menu service tests, including server-side pricing through the order service.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  createMenuCategory, updateMenuCategory, createMenuItem, updateMenuItem, setMenuItemAvailability,
  addVariant, updateVariant, createModifierGroup, addModifierOption, updateModifierOption, attachModifierGroup, detachModifierGroup, listMenu,
} from "@/server/services/menu";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string;
let admin: AccessContext, mgrA: AccessContext, captainA: AccessContext, org2: AccessContext;
let pizzaId: string, largeId: string, crustGroup: string, toppingGroup: string, thin: string, stuffed: string, olives: string, jalapeno: string;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Menu Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `MA${RUN}`, name: "A" } })).id;
  admin = { userId: "admin", organizationId: orgId, outletIds: [outletA], roles: ["ADMIN"], outletRoles: {}, orgRoles: ["ADMIN"], isOrgWide: true, isSuperAdmin: false };
  mgrA = { userId: "mgr", organizationId: orgId, outletIds: [outletA], roles: ["MANAGER"], outletRoles: { [outletA]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  captainA = { ...mgrA, userId: "cap", roles: ["CAPTAIN"], outletRoles: { [outletA]: ["CAPTAIN"] } };
  org2 = systemContext((await prisma.organization.create({ data: { name: `Menu Org2 ${RUN}` } })).id, []);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("menu management", () => {
  it("only org-wide menu managers can change the org menu", async () => {
    await expect(createMenuCategory(mgrA, { name: "Pizza" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createMenuCategory(captainA, { name: "Pizza" })).rejects.toBeInstanceOf(ForbiddenError);
    const cat = await createMenuCategory(admin, { name: "Pizza", sortOrder: 1 });
    await expect(createMenuCategory(admin, { name: "Pizza" })).rejects.toBeInstanceOf(ValidationError);
    const item = await createMenuItem(admin, { name: "Margherita", categoryId: cat.id, price: 300, taxPct: 5, posCode: `MARG-${RUN}` });
    pizzaId = item.id;
    await expect(createMenuItem(admin, { name: "Margherita", price: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createMenuItem(admin, { name: "Other", price: 1, posCode: `MARG-${RUN}` })).rejects.toBeInstanceOf(ValidationError);
    await expect(createMenuItem(admin, { name: "Neg", price: -1 })).rejects.toThrow();
    await expect(setMenuItemAvailability(mgrA, pizzaId, { soldOut: true })).rejects.toBeInstanceOf(ForbiddenError);
    await updateMenuCategory(admin, cat.id, { sortOrder: 2 });
  });

  it("price changes are audited as PRICE_CHANGE with before/after", async () => {
    await updateMenuItem(admin, pizzaId, { price: 320 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "MenuItem", entityId: pizzaId, action: "PRICE_CHANGE" } });
    expect(JSON.parse(audit.before!).price).toBe(300);
    expect(JSON.parse(audit.after!).price).toBe(320);
  });

  it("variants and modifier groups validate their data", async () => {
    largeId = (await addVariant(admin, { menuItemId: pizzaId, name: "Large", priceDelta: 180 })).id;
    await expect(addVariant(admin, { menuItemId: pizzaId, name: "Free", priceDelta: -400 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createModifierGroup(admin, { name: "Bad", minSelect: 3, maxSelect: 1 })).rejects.toThrow();
    crustGroup = (await createModifierGroup(admin, { name: "Crust", minSelect: 1, maxSelect: 1 })).id;
    toppingGroup = (await createModifierGroup(admin, { name: "Toppings", minSelect: 0, maxSelect: 2 })).id;
    thin = (await addModifierOption(admin, { groupId: crustGroup, name: "Thin" })).id;
    stuffed = (await addModifierOption(admin, { groupId: crustGroup, name: "Cheese Stuffed", priceDelta: 60 })).id;
    olives = (await addModifierOption(admin, { groupId: toppingGroup, name: "Olives", priceDelta: 30 })).id;
    jalapeno = (await addModifierOption(admin, { groupId: toppingGroup, name: "Jalapeno", priceDelta: 25 })).id;
    await attachModifierGroup(admin, pizzaId, crustGroup);
    await attachModifierGroup(admin, pizzaId, toppingGroup);
    const menu = await listMenu(prisma, captainA, { activeOnly: true });
    const pizza = menu.find((m) => m.id === pizzaId)!;
    expect(pizza.variants.map((v) => v.name)).toEqual(["Large"]);
    expect(pizza.modifierGroups).toHaveLength(2);
  });

  it("another organization cannot touch this menu", async () => {
    await expect(updateMenuItem(org2, pizzaId, { price: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(attachModifierGroup(org2, pizzaId, crustGroup)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listMenu(prisma, org2)).toEqual([]);
  });
});

describe("server-side pricing on orders", () => {
  it("prices variant + modifiers from the menu, per unit", async () => {
    const order = await createOrder(captainA, { outletId: outletA });
    const line = await addOrderItem(captainA, order.id, { menuItemId: pizzaId, variantId: largeId, modifierOptionIds: [stuffed, olives], qty: 2 });
    expect(line.name).toBe("Margherita (Large)");
    expect(num(line.unitPrice)).toBe(500); // 320 + 180
    expect(num(line.lineTotal)).toBe(1180); // 2 × (500 + 60 + 30)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(num(o.subtotal)).toBe(1180);
    expect(num(o.tax)).toBe(59);
  });

  it("rejects client prices, bad selections and unavailable items", async () => {
    const order = await createOrder(captainA, { outletId: outletA });
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, unitPrice: 1, modifierOptionIds: [thin] })).rejects.toBeInstanceOf(ValidationError);
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, modifiers: [{ name: "Free gold", priceDelta: -300 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId })).rejects.toBeInstanceOf(ValidationError); // crust required
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, modifierOptionIds: [thin, stuffed] })).rejects.toBeInstanceOf(ValidationError); // max 1
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, modifierOptionIds: [thin, olives, jalapeno, olives] })).rejects.toBeInstanceOf(ValidationError); // duplicate
    const foreignGroup = await createModifierGroup(admin, { name: "Drinks size" });
    const big = await addModifierOption(admin, { groupId: foreignGroup.id, name: "Big" });
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, modifierOptionIds: [thin, big.id] })).rejects.toBeInstanceOf(ValidationError); // not attached

    await updateModifierOption(admin, olives, { active: false });
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, modifierOptionIds: [thin, olives] })).rejects.toBeInstanceOf(ValidationError);
    await updateVariant(admin, largeId, { active: false });
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, variantId: largeId, modifierOptionIds: [thin] })).rejects.toBeInstanceOf(ValidationError);

    await setMenuItemAvailability(admin, pizzaId, { soldOut: true });
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, modifierOptionIds: [thin] })).rejects.toBeInstanceOf(ValidationError);
    await setMenuItemAvailability(admin, pizzaId, { soldOut: false, active: false });
    await expect(addOrderItem(captainA, order.id, { menuItemId: pizzaId, modifierOptionIds: [thin] })).rejects.toBeInstanceOf(ValidationError);
    await setMenuItemAvailability(admin, pizzaId, { active: true });
    await detachModifierGroup(admin, pizzaId, crustGroup);
    const ok = await addOrderItem(captainA, order.id, { menuItemId: pizzaId });
    expect(num(ok.unitPrice)).toBe(320);
  });
});
