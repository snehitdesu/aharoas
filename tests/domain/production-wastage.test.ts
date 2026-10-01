/**
 * Production batch + wastage document workflows against the real ledger.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createGRN, postGRN } from "@/server/services/procurement";
import { createRecipe, approveRecipeVersion } from "@/server/services/recipe";
import { createProductionBatch, startProductionBatch, completeProductionBatch, cancelProductionBatch, listProductionBatches } from "@/server/services/production";
import { createWastage, postWastage, cancelWastage, wastageByReason } from "@/server/services/wastage";
import { currentQuantity, getAvgCost } from "@/server/services/inventory";
import { detectAnomalies } from "@/server/services/anomaly";
import { wastageCost } from "@/server/services/analytics";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string;
let ctx: AccessContext, mgrA: AccessContext, storeA: AccessContext, mgrB: AccessContext, org2: AccessContext;
let mGinger: string, mGarlic: string, mGGP: string, mOil: string, unitG: string, ggpRecipe: string;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const qtyOf = async (materialId: string, outletId = outletA) => num(await currentQuantity(prisma, ctx, outletId, materialId));

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Prod Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  mgrA = member("MANAGER", outletA); storeA = member("STORE", outletA); mgrB = member("MANAGER", outletB);
  org2 = systemContext((await prisma.organization.create({ data: { name: `Prod Org2 ${RUN}` } })).id, []);
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  unitG = (await prisma.unit.create({ data: { organizationId: orgId, code: `g${RUN}`, name: "g", kind: "WEIGHT" } })).id;
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: unitG, toUnitId: kg, factor: 0.001 } });
  const mk = async (n: string) => (await prisma.material.create({ data: { organizationId: orgId, sku: `${n}-${RUN}`, name: n, baseUnitId: kg } })).id;
  mGinger = await mk("Ginger"); mGarlic = await mk("Garlic"); mGGP = await mk("GGP"); mOil = await mk("Oil");
  const vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `PV ${RUN}` } })).id;
  const grn = await createGRN(ctx, { outletId: outletA, vendorId, lines: [{ materialId: mGinger, qty: 10, rate: 100 }, { materialId: mGarlic, qty: 10, rate: 150 }, { materialId: mOil, qty: 50, rate: 120 }] });
  await postGRN(ctx, grn.id);
  const r = await createRecipe(ctx, { name: "GGP", outputType: "SUB_RECIPE", outputMaterialId: mGGP, yieldQty: 1, lines: [
    { componentType: "MATERIAL", materialId: mGinger, qty: 0.5 }, { componentType: "MATERIAL", materialId: mGarlic, qty: 0.5 },
  ] });
  ggpRecipe = r.recipe.id;
  await approveRecipeVersion(ctx, r.version.id);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("production batches", () => {
  it("draft -> start -> complete consumes inputs and produces output in the ledger", async () => {
    const batch = await createProductionBatch(mgrA, { outletId: outletA, recipeId: ggpRecipe, plannedQty: 2, batchNo: "GGP-01" });
    expect(batch.lines.map((l) => [l.materialId, num(l.qty)]).sort()).toEqual([[mGarlic, 1], [mGinger, 1]].sort());
    await expect(completeProductionBatch(mgrA, batch.id, { actualQty: 1.9 })).rejects.toBeInstanceOf(ValidationError); // must start first
    await startProductionBatch(mgrA, batch.id);
    const res = await completeProductionBatch(mgrA, batch.id, { actualQty: 1.9 });
    expect(res.inputCost).toBe(250);
    expect(res.outputRate).toBeCloseTo(131.58, 2);

    expect(await qtyOf(mGinger)).toBeCloseTo(9, 6);
    expect(await qtyOf(mGarlic)).toBeCloseTo(9, 6);
    expect(await qtyOf(mGGP)).toBeCloseTo(1.9, 6);
    expect(num(await getAvgCost(prisma, ctx, outletA, mGGP))).toBeCloseTo(131.58, 2);
    const rows = await prisma.inventoryLedger.findMany({ where: { sourceType: "PRODUCTION", sourceId: batch.id } });
    expect(rows.map((r) => r.txnType).sort()).toEqual(["PRODUCTION_CONSUMPTION", "PRODUCTION_CONSUMPTION", "PRODUCTION_OUTPUT"]);
    expect(await prisma.auditLog.count({ where: { entityType: "ProductionBatch", entityId: batch.id, action: "INVENTORY_MOVEMENT" } })).toBe(1);

    await expect(completeProductionBatch(mgrA, batch.id, { actualQty: 1.9 })).rejects.toBeInstanceOf(ValidationError); // duplicate posting
    expect(await prisma.inventoryLedger.count({ where: { sourceId: batch.id } })).toBe(3);
  });

  it("rejects completion on insufficient stock with no partial ledger effect", async () => {
    const batch = await createProductionBatch(mgrA, { outletId: outletA, recipeId: ggpRecipe, plannedQty: 100 });
    await startProductionBatch(mgrA, batch.id);
    await expect(completeProductionBatch(mgrA, batch.id, { actualQty: 100 })).rejects.toThrow(/Insufficient stock/);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: batch.id } })).toBe(0);
    expect((await prisma.productionBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("IN_PROGRESS");
    await expect(completeProductionBatch(mgrA, batch.id, { actualQty: 1, consumed: [{ materialId: mOil, qty: 1 }] })).rejects.toBeInstanceOf(ValidationError); // not an input
    expect((await cancelProductionBatch(mgrA, batch.id)).status).toBe("CANCELLED");
  });

  it("rejects wrong outlet, wrong organization and non-producible recipes", async () => {
    await expect(createProductionBatch(mgrB, { outletId: outletA, recipeId: ggpRecipe, plannedQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    const batch = await createProductionBatch(mgrA, { outletId: outletA, recipeId: ggpRecipe, plannedQty: 1 });
    await expect(startProductionBatch(mgrB, batch.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startProductionBatch(org2, batch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createProductionBatch(org2, { outletId: outletA, recipeId: ggpRecipe, plannedQty: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createProductionBatch(member("KITCHEN", outletA), { outletId: outletA, recipeId: ggpRecipe, plannedQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    const page = await listProductionBatches(prisma, mgrA, { outletId: outletA, take: 2 });
    expect(page.items).toHaveLength(2);
  });
});

describe("wastage documents", () => {
  it("draft -> post writes negative ledger rows at avg cost, in base units, once", async () => {
    const before = await qtyOf(mOil);
    const doc = await createWastage(storeA, { outletId: outletA, reason: "SPILLAGE", lines: [{ materialId: mOil, qty: 2500, unitId: unitG }] });
    expect(doc.status).toBe("DRAFT");
    expect(num(doc.lines[0].qty)).toBe(2.5);
    expect(await qtyOf(mOil)).toBe(before); // draft has no stock effect
    const { totalCost } = await postWastage(storeA, doc.id);
    expect(totalCost).toBe(300);
    expect(await qtyOf(mOil)).toBeCloseTo(before - 2.5, 6);
    const row = await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceType: "WASTAGE", sourceId: doc.id } });
    expect(row).toMatchObject({ txnType: "WASTAGE" });
    expect(num(row.amount)).toBe(-300);
    expect(num((await prisma.wastageLine.findFirstOrThrow({ where: { wastageId: doc.id } })).estCost)).toBe(300);
    await expect(postWastage(storeA, doc.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: doc.id } })).toBe(1);
  });

  it("cannot waste more than is on hand; cancelled drafts never touch stock", async () => {
    const doc = await createWastage(storeA, { outletId: outletA, reason: "DAMAGED", lines: [{ materialId: mGinger, qty: 500 }] });
    await expect(postWastage(storeA, doc.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: doc.id } })).toBe(0);
    expect((await cancelWastage(storeA, doc.id)).status).toBe("CANCELLED");
    await expect(postWastage(storeA, doc.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("large wastage needs approval authority; reason drives the ledger type", async () => {
    const big = await createWastage(storeA, { outletId: outletA, reason: "EXPIRED", lines: [{ materialId: mOil, qty: 20 }] }); // 20 × 120 = 2400
    await expect(postWastage(storeA, big.id)).rejects.toBeInstanceOf(ForbiddenError);
    await postWastage(mgrA, big.id);
    expect((await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: big.id } })).txnType).toBe("SPOILAGE");
    const meal = await createWastage(storeA, { outletId: outletA, reason: "STAFF_MEAL", lines: [{ materialId: mGinger, qty: 0.1 }] });
    await postWastage(storeA, meal.id);
    expect((await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: meal.id } })).txnType).toBe("STAFF_MEAL");
  });

  it("feeds analytics and heavy-wastage anomaly detection", async () => {
    expect(await wastageCost(prisma, mgrA, { outletId: outletA })).toBeCloseTo(300 + 2400 + 10, 2);
    const byReason = await wastageByReason(prisma, mgrA, { outletId: outletA });
    expect(byReason[0]).toMatchObject({ reason: "EXPIRED", cost: 2400, documents: 1 });
    const found = await detectAnomalies(ctx, { outletId: outletA });
    expect(found.some((f) => f.type === "HEAVY_WASTAGE")).toBe(true);
  });

  it("enforces outlet and organization scope", async () => {
    await expect(createWastage(mgrB, { outletId: outletA, reason: "OTHER", lines: [{ materialId: mOil, qty: 1 }] })).rejects.toBeInstanceOf(ForbiddenError);
    const doc = await createWastage(storeA, { outletId: outletA, reason: "OTHER", lines: [{ materialId: mOil, qty: 1 }] });
    await expect(postWastage(mgrB, doc.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(postWastage(org2, doc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createWastage(storeA, { outletId: outletA, reason: "OTHER", lines: [{ materialId: mOil, qty: 1 }, { materialId: mOil, qty: 2 }] })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("single-document reads (detail screens)", () => {
  it("return the document with lines, scoped to organization, outlet and inventory.view", async () => {
    const { getWastage, getProductionBatch } = await import("@/server/services/documentQueries");
    const w = await createWastage(mgrA, { outletId: outletA, reason: "DAMAGED", lines: [{ materialId: mOil, qty: 0.1 }] });
    const b = await createProductionBatch(mgrA, { outletId: outletA, recipeId: ggpRecipe, plannedQty: 1 });

    const wr = await getWastage(prisma, storeA, w.id);
    expect(wr.number).toBe(w.number);
    expect(wr.lines.map((l) => l.materialId)).toEqual([mOil]);
    const br = await getProductionBatch(prisma, mgrA, b.id);
    expect(br.outputMaterialId).toBe(mGGP);
    expect(br.lines).toHaveLength(2);

    await expect(getWastage(prisma, mgrB, w.id)).rejects.toBeInstanceOf(ForbiddenError); // other outlet
    await expect(getProductionBatch(prisma, mgrB, b.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getWastage(prisma, org2, w.id)).rejects.toBeInstanceOf(NotFoundError); // other organization
    await expect(getProductionBatch(prisma, org2, b.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getWastage(prisma, mgrA, "missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(getWastage(prisma, member("CASHIER", outletA), w.id)).rejects.toBeInstanceOf(ForbiddenError); // no inventory.view
  });
});
