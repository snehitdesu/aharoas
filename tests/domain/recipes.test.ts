/**
 * Recipe authoring tests: creation, versions, approval, effective dates,
 * history preservation, nesting, cycle rejection, costing, and which version
 * consumption actually uses. Costs come from real GRN postings.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  createRecipe, createRecipeVersion, addRecipeLine, removeRecipeLine, approveRecipeVersion, archiveRecipeVersion, updateRecipeVersion,
  getActiveVersion, getRecipe, explodeRecipe, calculateRecipeCost, menuItemCostAndMargin,
} from "@/server/services/recipe";
import { createMenuItem } from "@/server/services/menu";
import { createGRN, postGRN } from "@/server/services/procurement";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { RecipeCycleError } from "@/domain/recipe/cycle";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, vendorId: string;
let ctx: AccessContext, mgrA: AccessContext, org2: AccessContext;
let mRice: string, mChicken: string, mGinger: string, mGarlic: string, mGGP: string, mMasala: string;
let biryaniItem: string, ggpRecipe: string, biryaniRecipe: string, v1: string, v2: string;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Recipe Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PA${RUN}`, name: "A" } })).id;
  ctx = systemContext(orgId, [outletA]);
  mgrA = { userId: "mgr", organizationId: orgId, outletIds: [outletA], roles: ["MANAGER"], outletRoles: { [outletA]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  org2 = systemContext((await prisma.organization.create({ data: { name: `Recipe Org2 ${RUN}` } })).id, []);
  vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `RV ${RUN}` } })).id;
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  const mk = async (n: string) => (await prisma.material.create({ data: { organizationId: orgId, sku: `${n}-${RUN}`, name: n, baseUnitId: kg } })).id;
  mRice = await mk("Rice"); mChicken = await mk("Chicken"); mGinger = await mk("Ginger"); mGarlic = await mk("Garlic"); mGGP = await mk("GGP"); mMasala = await mk("Masala");
  const grn = await createGRN(ctx, { outletId: outletA, vendorId, lines: [
    { materialId: mRice, qty: 100, rate: 80 }, { materialId: mChicken, qty: 50, rate: 200 },
    { materialId: mGinger, qty: 10, rate: 100 }, { materialId: mGarlic, qty: 10, rate: 150 },
  ] });
  await postGRN(ctx, grn.id);
  biryaniItem = (await createMenuItem(ctx, { name: `Biryani ${RUN}`, price: 300 })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("creation and nesting", () => {
  it("creates a sub-recipe and a menu recipe as drafts; outlet managers cannot author", async () => {
    await expect(createRecipe(mgrA, { name: "X", outputType: "SUB_RECIPE", outputMaterialId: mGGP })).rejects.toBeInstanceOf(ForbiddenError);
    const ggp = await createRecipe(ctx, { name: "Ginger Garlic Paste", outputType: "SUB_RECIPE", outputMaterialId: mGGP, yieldQty: 1, lines: [
      { componentType: "MATERIAL", materialId: mGinger, qty: 0.5 }, { componentType: "MATERIAL", materialId: mGarlic, qty: 0.5 },
    ] });
    ggpRecipe = ggp.recipe.id;
    expect(ggp.version.status).toBe("DRAFT");

    const main = await createRecipe(ctx, { name: "Biryani", outputType: "MENU_ITEM", menuItemId: biryaniItem, lines: [
      { componentType: "MATERIAL", materialId: mRice, qty: 0.2 }, { componentType: "MATERIAL", materialId: mChicken, qty: 0.25 },
      { componentType: "SUB_RECIPE", subRecipeId: ggpRecipe, qty: 0.05 },
    ] });
    biryaniRecipe = main.recipe.id; v1 = main.version.id;
    await expect(createRecipe(ctx, { name: "Dup", outputType: "MENU_ITEM", menuItemId: biryaniItem })).rejects.toBeInstanceOf(ValidationError);
    await expect(createRecipe(ctx, { name: "Bad", outputType: "MENU_ITEM", outputMaterialId: mGGP })).rejects.toBeInstanceOf(ValidationError);
    await expect(createRecipe(org2, { name: "Foreign", outputType: "SUB_RECIPE", outputMaterialId: mGGP })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("approval requires approved sub-recipes and lines", async () => {
    await expect(approveRecipeVersion(ctx, v1)).rejects.toBeInstanceOf(ValidationError); // GGP not approved yet
    const ggpV1 = (await getRecipe(prisma, ctx, ggpRecipe))!.versions[0].id;
    await approveRecipeVersion(ctx, ggpV1);
    const approved = await approveRecipeVersion(ctx, v1);
    expect(approved.status).toBe("APPROVED");
    const empty = await createRecipe(ctx, { name: "Empty", outputType: "SUB_RECIPE", outputMaterialId: mMasala });
    await expect(approveRecipeVersion(ctx, empty.version.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("explodes nested recipes with correct scaling", async () => {
    const exploded = await explodeRecipe(prisma, ctx, v1, 4);
    expect(num(exploded.get(mRice)!)).toBeCloseTo(0.8, 6);
    expect(num(exploded.get(mChicken)!)).toBeCloseTo(1.0, 6);
    expect(num(exploded.get(mGinger)!)).toBeCloseTo(0.1, 6); // 4 × 0.05 × 0.5
    expect(num(exploded.get(mGarlic)!)).toBeCloseTo(0.1, 6);
  });
});

describe("cycle protection", () => {
  it("rejects self-reference and indirect cycles at write time", async () => {
    const masala = await createRecipe(ctx, { name: "Masala Base", outputType: "SUB_RECIPE", outputMaterialId: mMasala, lines: [{ componentType: "SUB_RECIPE", subRecipeId: ggpRecipe, qty: 0.1 }] });
    const ggpDraft = await createRecipeVersion(ctx, ggpRecipe);
    await expect(addRecipeLine(ctx, ggpDraft.id, { componentType: "SUB_RECIPE", subRecipeId: masala.recipe.id, qty: 0.1 })).rejects.toBeInstanceOf(RecipeCycleError); // GGP -> Masala -> GGP
    await expect(addRecipeLine(ctx, ggpDraft.id, { componentType: "SUB_RECIPE", subRecipeId: ggpRecipe, qty: 0.1 })).rejects.toBeInstanceOf(RecipeCycleError); // self
    await expect(addRecipeLine(ctx, ggpDraft.id, { componentType: "SUB_RECIPE", subRecipeId: biryaniRecipe, qty: 1 })).rejects.toBeInstanceOf(ValidationError); // menu recipe as component
    await archiveRecipeVersion(ctx, ggpDraft.id); // abandon the draft
  });
});

describe("versioning and history", () => {
  it("approved versions are immutable; a new version copies lines and becomes active on approval", async () => {
    await expect(addRecipeLine(ctx, v1, { componentType: "MATERIAL", materialId: mRice, qty: 1 })).rejects.toBeInstanceOf(ValidationError);
    const draft = await createRecipeVersion(ctx, biryaniRecipe, { notes: "More chicken" });
    v2 = draft.id;
    expect(draft.version).toBe(2);
    await expect(createRecipeVersion(ctx, biryaniRecipe)).rejects.toBeInstanceOf(ValidationError); // one draft at a time
    const lines = await prisma.recipeLine.findMany({ where: { recipeVersionId: v2 } });
    expect(lines).toHaveLength(3);
    await removeRecipeLine(ctx, lines.find((l) => l.materialId === mChicken)!.id);
    await addRecipeLine(ctx, v2, { componentType: "MATERIAL", materialId: mChicken, qty: 0.3 });
    expect((await getActiveVersion(prisma, ctx, biryaniRecipe)).id).toBe(v1); // draft not active
    await approveRecipeVersion(ctx, v2);
    expect((await getActiveVersion(prisma, ctx, biryaniRecipe)).id).toBe(v2);

    const history = (await getRecipe(prisma, ctx, biryaniRecipe))!.versions;
    const old = history.find((v) => v.id === v1)!;
    expect(old.status).toBe("APPROVED");
    expect(num(old.lines.find((l) => l.materialId === mChicken)!.qty)).toBe(0.25); // v1 preserved
  });

  it("a future-dated version does not take effect early", async () => {
    const future = new Date(Date.now() + 7 * 86400_000);
    const v3 = await createRecipeVersion(ctx, biryaniRecipe);
    await updateRecipeVersion(ctx, v3.id, { effectiveFrom: future });
    await approveRecipeVersion(ctx, v3.id);
    expect((await getActiveVersion(prisma, ctx, biryaniRecipe)).id).toBe(v2);
    expect((await getActiveVersion(prisma, ctx, biryaniRecipe, new Date(future.getTime() + 1000))).id).toBe(v3.id);
  });
});

describe("costing and consumption", () => {
  it("costs the active version at weighted-average cost and reports margin", async () => {
    const cost = await calculateRecipeCost(prisma, ctx, v2, { outletId: outletA, quantity: 1 });
    expect(num(cost.total)).toBe(82.25); // 0.2×80 + 0.3×200 + 0.05×(0.5×100 + 0.5×150)
    const m = await menuItemCostAndMargin(prisma, ctx, biryaniItem, outletA);
    expect(m).toMatchObject({ versionId: v2, price: 300, cost: 82.25, margin: 217.75, foodCostPct: 27.42 });
  });

  it("order consumption uses the approved version in effect, never a draft", async () => {
    await createRecipeVersion(ctx, biryaniRecipe, { yieldQty: 0.5 }); // pending draft with different yield
    const before = num((await prisma.inventoryLedger.aggregate({ where: { outletId: outletA, materialId: mChicken }, _sum: { qty: true } }))._sum.qty!);
    const order = await createOrder(ctx, { outletId: outletA });
    await addOrderItem(ctx, order.id, { menuItemId: biryaniItem, qty: 2 });
    const p = await createPayment(ctx, order.id, { method: "CASH", amount: 630 });
    await verifyPayment(ctx, p.id);
    const after = num((await prisma.inventoryLedger.aggregate({ where: { outletId: outletA, materialId: mChicken }, _sum: { qty: true } }))._sum.qty!);
    expect(after).toBeCloseTo(before - 0.6, 6); // v2: 2 × 0.3
  });

  it("a menu item whose only recipe version is a draft is surfaced as unmapped", async () => {
    const item = (await createMenuItem(ctx, { name: `Draft Dish ${RUN}`, price: 100, taxPct: 0 })).id;
    await createRecipe(ctx, { name: "Draft Dish", outputType: "MENU_ITEM", menuItemId: item, lines: [{ componentType: "MATERIAL", materialId: mRice, qty: 0.1 }] });
    const order = await createOrder(ctx, { outletId: outletA });
    await addOrderItem(ctx, order.id, { menuItemId: item, qty: 1 });
    const p = await createPayment(ctx, order.id, { method: "CASH", amount: 100 });
    await verifyPayment(ctx, p.id);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: order.id } })).toBe(0);
    expect(await prisma.unmappedSale.count({ where: { outletId: outletA, posCode: item } })).toBe(1);
  });
});
