/**
 * The Coders' Cafe starter imports the real menu + tables T01–T10 into an
 * EXISTING restaurant (desktop first run / empty Menu screen): additive, only
 * into an empty menu, atomic, random QR tokens, no accounts, RBAC-checked.
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { createMenuItem } from "@/server/services/menu";
import { importCodersCafeStarter, MENU_NOT_EMPTY } from "@/server/services/starterMenu";
import { menuItemCount, CODERS_CAFE_MENU } from "../../prisma/coders-cafe/menu";
import { cafeTableToken } from "../../prisma/coders-cafe/seed";

const RUN = Date.now().toString(36);
afterAll(async () => { await prisma.$disconnect(); });

/** An org shaped exactly like the desktop wizard leaves it (bootstrapOwner itself refuses a non-empty DB). */
async function restaurant(tag: string) {
  const org = await prisma.organization.create({ data: { name: `Starter ${tag} ${RUN}` } });
  const outlet = await prisma.outlet.create({ data: { organizationId: org.id, code: `S${tag}${RUN}`.toUpperCase().slice(0, 20), name: "Main" } });
  const mk = async (role: string, outletId: string | null) => {
    const u = await prisma.user.create({ data: { organizationId: org.id, email: `${role.toLowerCase()}-${tag}-${RUN}@starter.test`, name: role, passwordHash: "x" } });
    await prisma.membership.create({ data: { organizationId: org.id, userId: u.id, outletId, role } });
    return buildAccessContext(prisma, u.id);
  };
  return { org, outlet, owner: await mk("OWNER", null), cashier: await mk("CASHIER", outlet.id) };
}

describe("Coders' Cafe starter import", () => {
  it("imports the real menu and T01–T10 into an existing restaurant, with random QR tokens and no accounts", async () => {
    const { org, outlet, owner } = await restaurant("a");
    await prisma.restaurantTable.create({ data: { organizationId: org.id, outletId: outlet.id, code: "T07", capacity: 6, qrToken: `keep-${RUN}` } });
    const users = await prisma.user.count({ where: { organizationId: org.id } });

    const r = await importCodersCafeStarter(owner, { outletId: outlet.id }, prisma);
    expect(r).toMatchObject({ categories: 8, items: 64, tablesKept: ["T07"] });
    expect(r.tablesCreated).toHaveLength(9);
    expect(await prisma.menuCategory.count({ where: { organizationId: org.id } })).toBe(CODERS_CAFE_MENU.length);
    expect(await prisma.menuItem.count({ where: { organizationId: org.id } })).toBe(menuItemCount());
    expect(await prisma.menuItemVariant.count({ where: { menuItem: { organizationId: org.id } } })).toBe(r.variants);
    expect(r.variants).toBeGreaterThan(0);
    expect(await prisma.user.count({ where: { organizationId: org.id } })).toBe(users);

    const tables = await prisma.restaurantTable.findMany({ where: { outletId: outlet.id }, orderBy: { code: "asc" } });
    expect(tables.map((t) => t.code)).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"]);
    const t07 = tables.find((t) => t.code === "T07")!;
    expect(t07).toMatchObject({ capacity: 6, qrToken: `keep-${RUN}` }); // existing table untouched
    for (const t of tables.filter((x) => x.code !== "T07")) {
      expect(t.qrToken).toBeTruthy();
      expect(t.qrToken).not.toBe(cafeTableToken(t.code)); // never the public, derivable demo token
    }
    expect(await prisma.auditLog.count({ where: { organizationId: org.id, entityType: "MenuItem", action: "CREATE" } })).toBe(64);
  });

  it("refuses a restaurant that already has a menu and changes nothing", async () => {
    const { org, outlet, owner } = await restaurant("b");
    await createMenuItem(owner, { name: `House Special ${RUN}`, price: 150 });
    await expect(importCodersCafeStarter(owner, { outletId: outlet.id }, prisma)).rejects.toThrow(MENU_NOT_EMPTY);
    expect(await prisma.menuItem.count({ where: { organizationId: org.id } })).toBe(1);
    expect(await prisma.restaurantTable.count({ where: { outletId: outlet.id } })).toBe(0);
  });

  it("a second import is refused (idempotent: never duplicates)", async () => {
    const { org, outlet, owner } = await restaurant("c");
    await importCodersCafeStarter(owner, { outletId: outlet.id }, prisma);
    await expect(importCodersCafeStarter(owner, { outletId: outlet.id }, prisma)).rejects.toThrow(MENU_NOT_EMPTY);
    expect(await prisma.menuItem.count({ where: { organizationId: org.id } })).toBe(64);
    expect(await prisma.restaurantTable.count({ where: { outletId: outlet.id } })).toBe(10);
  });

  it("requires menu.manage: a cashier cannot import", async () => {
    const { org, outlet, cashier } = await restaurant("d");
    await expect(importCodersCafeStarter(cashier, { outletId: outlet.id }, prisma)).rejects.toThrow(/permission/i);
    expect(await prisma.menuCategory.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it("refuses another organization's outlet (no rows written anywhere)", async () => {
    const a = await restaurant("e");
    const b = await restaurant("f");
    await expect(importCodersCafeStarter(a.owner, { outletId: b.outlet.id }, prisma)).rejects.toThrow(/Outlet not found/);
    expect(await prisma.menuCategory.count({ where: { organizationId: { in: [a.org.id, b.org.id] } } })).toBe(0);
    expect(await prisma.restaurantTable.count({ where: { outletId: b.outlet.id } })).toBe(0);
  });
});
