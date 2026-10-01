/**
 * Small backend additions made for the menu / recipe / master-data back office:
 *  - updateModifierGroup (rename, selection rules, retire) + its API route
 *  - recipe reads resolve display names (materials, sub-recipes, units, output)
 *    so recipe.view alone is enough to read a recipe; list search + version summary
 *  - recipe cost lines carry material names / units
 *  - getMaterial reports whether stock has moved (base unit lock)
 *  - the shared recipe-version transition table matches the service
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import { RECIPE_VERSION_TRANSITIONS } from "@/constants/enums";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { systemContext } from "@/server/auth/context";
import { createMenuItem, createModifierGroup, addModifierOption, attachModifierGroup, updateModifierGroup, priceMenuSelection } from "@/server/services/menu";
import { createUnit, createUnitConversion, createMaterial, getMaterial, updateMaterial, listMaterials, createVendor, listVendors } from "@/server/services/masterData";
import { createCustomer, findCustomer } from "@/server/services/crm";
import { createRecipe, addRecipeLine, approveRecipeVersion, archiveRecipeVersion, createRecipeVersion, getRecipe, listRecipes, calculateRecipeCost, describeCostLines } from "@/server/services/recipe";
import { runInTx } from "@/server/services/_workflow";
import * as Menu from "@/app/api/menu/[[...path]]/route";
import * as Recipes from "@/app/api/recipes/[[...path]]/route";
import * as Master from "@/app/api/master/[[...path]]/route";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string;
let admin: AccessContext, mgrA: AccessContext, org2: AccessContext;
let kg: string, g: string, flour: string, dough: string, pizza: string;
let doughRecipe: string, pizzaRecipe: string, pizzaV1: string;
let kitchenToken: string, mgrToken: string, adminToken: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token: string; body?: unknown; query?: Record<string, string> }) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost", cookie: `${SESSION_COOKIE}=${opts.token}` };
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: (await res.json()) as any };
}
async function sessionFor(tag: string, role: string, outletId: string | null) {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${tag}-${RUN}@bo.test`, name: tag, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `BO Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `BA${RUN}`, name: "A" } })).id;
  admin = { userId: "admin", organizationId: orgId, outletIds: [outletA], roles: ["ADMIN"], outletRoles: {}, orgRoles: ["ADMIN"], isOrgWide: true, isSuperAdmin: false };
  mgrA = { userId: "mgr", organizationId: orgId, outletIds: [outletA], roles: ["MANAGER"], outletRoles: { [outletA]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  org2 = systemContext((await prisma.organization.create({ data: { name: `BO Org2 ${RUN}` } })).id, []);
  kg = (await createUnit(admin, { code: "kg", name: "Kilogram", kind: "WEIGHT" })).id;
  g = (await createUnit(admin, { code: "g", name: "Gram", kind: "WEIGHT" })).id;
  await createUnitConversion(admin, { fromUnitId: g, toUnitId: kg, factor: 0.001 });
  flour = (await createMaterial(admin, { sku: `FL-${RUN}`, name: "Flour", baseUnitId: kg })).id;
  dough = (await createMaterial(admin, { sku: `DO-${RUN}`, name: "Pizza dough", baseUnitId: kg })).id;
  pizza = (await createMenuItem(admin, { name: "Margherita", price: 300 })).id;
  kitchenToken = await sessionFor("kitchen", "KITCHEN", outletA);
  mgrToken = await sessionFor("mgr", "MANAGER", outletA);
  adminToken = await sessionFor("admin", "ADMIN", null);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("modifier group updates", () => {
  it("renames, changes rules (validated against current values) and retires a group; org-wide menu managers only", async () => {
    const group = await createModifierGroup(admin, { name: `Size ${RUN}`, minSelect: 1, maxSelect: 1 });
    const large = await addModifierOption(admin, { groupId: group.id, name: "Large", priceDelta: 50 });
    await attachModifierGroup(admin, pizza, group.id);

    await expect(updateModifierGroup(mgrA, group.id, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateModifierGroup(org2, group.id, { name: "X" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateModifierGroup(admin, group.id, { minSelect: 2 })).rejects.toBeInstanceOf(ValidationError); // 2 > current max 1
    await expect(updateModifierGroup(admin, group.id, { maxSelect: 0 })).rejects.toThrow();

    const renamed = await updateModifierGroup(admin, group.id, { name: `Pizza size ${RUN}`, minSelect: 0, maxSelect: 2 });
    expect(renamed).toMatchObject({ name: `Pizza size ${RUN}`, minSelect: 0, maxSelect: 2 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "ModifierGroup", entityId: group.id, action: "UPDATE" } });
    expect(JSON.parse(audit.before!)).toMatchObject({ minSelect: 1, maxSelect: 1 });

    // A retired group is skipped by pricing (existing priceMenuSelection rule).
    await updateModifierGroup(admin, group.id, { active: false });
    const priced = await runInTx(prisma, (tx) => priceMenuSelection(tx, admin, { menuItemId: pizza, modifierOptionIds: [] }));
    expect(priced.modifiers).toHaveLength(0);
    await expect(runInTx(prisma, (tx) => priceMenuSelection(tx, admin, { menuItemId: pizza, modifierOptionIds: [large.id] }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("is exposed as PATCH /api/menu/modifier-groups/:id with RBAC and 422 mapping", async () => {
    const group = await createModifierGroup(admin, { name: `Spice ${RUN}` });
    expect((await call(Menu, "PATCH", `modifier-groups/${group.id}`, { token: mgrToken, body: { active: false } })).status).toBe(403);
    expect((await call(Menu, "PATCH", `modifier-groups/${group.id}`, { token: adminToken, body: { minSelect: 5 } })).status).toBe(422);
    expect((await call(Menu, "PATCH", `modifier-groups/${group.id}`, { token: adminToken, body: { bogus: 1 } })).status).toBe(422);
    const ok = await call(Menu, "PATCH", `modifier-groups/${group.id}`, { token: adminToken, body: { active: false } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.active).toBe(false);
  });
});

describe("recipe reads for the back office", () => {
  it("resolve names, units and output; list supports search and carries version summaries", async () => {
    const d = await createRecipe(admin, { name: `Dough ${RUN}`, outputType: "SUB_RECIPE", outputMaterialId: dough, yieldQty: 1, yieldUnitId: kg, lines: [{ componentType: "MATERIAL", materialId: flour, qty: 600, unitId: g }] });
    doughRecipe = d.recipe.id;
    await approveRecipeVersion(admin, d.version.id);
    const p = await createRecipe(admin, { name: `Margherita ${RUN}`, outputType: "MENU_ITEM", menuItemId: pizza, lines: [{ componentType: "SUB_RECIPE", subRecipeId: doughRecipe, qty: 0.25 }] });
    pizzaRecipe = p.recipe.id;
    pizzaV1 = p.version.id;
    await addRecipeLine(admin, pizzaV1, { componentType: "MATERIAL", materialId: flour, qty: 0.01 });

    const full = await getRecipe(prisma, admin, doughRecipe);
    expect(full.outputMaterial).toMatchObject({ id: dough, name: "Pizza dough", unit: "kg" });
    expect(full.versions[0]).toMatchObject({ status: "APPROVED", yieldUnit: "kg" });
    expect(full.versions[0].lines[0]).toMatchObject({ name: "Flour", sku: `FL-${RUN}`, unit: "g" });

    const pz = await getRecipe(prisma, admin, pizzaRecipe);
    expect(pz.menuItem?.name).toBe("Margherita");
    const [sub, mat] = pz.versions[0].lines;
    expect(sub).toMatchObject({ componentType: "SUB_RECIPE", name: `Dough ${RUN}`, unit: null });
    expect(mat).toMatchObject({ componentType: "MATERIAL", name: "Flour", unit: "kg" }); // no unitId => base unit

    const found = await listRecipes(prisma, admin, { search: `Margherita ${RUN}` });
    expect(found.map((r) => r.id)).toEqual([pizzaRecipe]);
    expect(found[0].menuItem?.name).toBe("Margherita");
    expect(found[0].versions[0]).toMatchObject({ version: 1, status: "DRAFT" });
    await expect(getRecipe(prisma, org2, pizzaRecipe)).rejects.toThrow();
  });

  it("a KITCHEN user (recipe.view, no master.view) reads names over HTTP but cannot author", async () => {
    const r = await call(Recipes, "GET", pizzaRecipe, { token: kitchenToken });
    expect(r.status).toBe(200);
    expect(r.json.data.versions[0].lines.map((l: { name: string }) => l.name)).toEqual([`Dough ${RUN}`, "Flour"]);
    expect((await call(Master, "GET", "materials", { token: kitchenToken })).status).toBe(403);
    expect((await call(Recipes, "POST", `versions/${pizzaV1}/approve`, { token: kitchenToken })).status).toBe(403);
  });

  it("cost lines carry material names and base units (draft versions can be costed)", async () => {
    await prisma.outletMaterialCost.create({ data: { organizationId: orgId, outletId: outletA, materialId: flour, avgCost: 40 } });
    const cost = await calculateRecipeCost(prisma, admin, pizzaV1, { outletId: outletA });
    const lines = await describeCostLines(prisma, admin, cost.lines);
    expect(lines).toEqual([expect.objectContaining({ materialId: flour, name: "Flour", sku: `FL-${RUN}`, unit: "kg", quantity: 0.16, unitCost: 40, cost: 6.4 })]);

    const http = await call(Recipes, "GET", `versions/${pizzaV1}/cost`, { token: kitchenToken, query: { outletId: outletA } });
    expect(http.status).toBe(200);
    expect(http.json.data).toMatchObject({ total: 6.4, lines: [{ name: "Flour", unit: "kg" }] });
  });

  it("the shared transition table matches the service", async () => {
    expect(RECIPE_VERSION_TRANSITIONS).toEqual({ DRAFT: ["APPROVED", "ARCHIVED"], APPROVED: ["ARCHIVED"], ARCHIVED: [] });
    await approveRecipeVersion(admin, pizzaV1);
    const v2 = await createRecipeVersion(admin, pizzaRecipe);
    await archiveRecipeVersion(admin, v2.id); // DRAFT -> ARCHIVED (abandon)
    await archiveRecipeVersion(admin, pizzaV1); // APPROVED -> ARCHIVED
    await expect(archiveRecipeVersion(admin, pizzaV1)).rejects.toBeInstanceOf(ValidationError); // ARCHIVED is terminal
    await expect(approveRecipeVersion(admin, v2.id)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("material detail", () => {
  it("reports stockMoved so the base unit can be locked; the service still enforces it", async () => {
    const m = await createMaterial(admin, { sku: `TM-${RUN}`, name: "Tomato", baseUnitId: kg });
    expect((await getMaterial(prisma, admin, m.id)).stockMoved).toBe(false);
    await updateMaterial(admin, m.id, { baseUnitId: g }); // allowed before any movement
    await prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: outletA, materialId: m.id, txnType: "OPENING_BALANCE", qty: 1000 } });
    expect((await getMaterial(prisma, admin, m.id)).stockMoved).toBe(true);
    await expect(updateMaterial(admin, m.id, { baseUnitId: kg })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("search", () => {
  it("is case-insensitive for materials, vendors, customers and recipes (PostgreSQL LIKE is case-sensitive)", async () => {
    await createVendor(admin, { name: `Fresh Farms ${RUN}` });
    await createCustomer(admin, { name: `Meera Iyer ${RUN}`, phone: `97${Date.now().toString().slice(-8)}` });
    for (const q of ["flour", "FLOUR", "Flour"]) expect((await listMaterials(prisma, admin, { search: q })).items.map((m) => m.id)).toContain(flour);
    expect((await listVendors(prisma, admin, { search: `fresh farms ${RUN}`.toUpperCase() })).items).toHaveLength(1);
    expect(await findCustomer(prisma, admin, { search: `meera iyer ${RUN}` })).toHaveLength(1);
    expect((await listRecipes(prisma, admin, { search: `DOUGH ${RUN}`.toLowerCase() })).map((r) => r.id)).toEqual([doughRecipe]);
  });
});
