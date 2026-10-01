/**
 * Production batches: turning raw materials into a stockable semi-finished
 * material (the output of a SUB_RECIPE), e.g. a gravy base or a masala.
 *
 *   create (DRAFT: pins the recipe version in effect, plans input lines)
 *     -> start (IN_PROGRESS)
 *     -> complete (COMPLETED: PRODUCTION_CONSUMPTION rows for every input,
 *                  one PRODUCTION_OUTPUT row for the output, in ONE transaction)
 *   DRAFT/IN_PROGRESS -> CANCELLED (no stock effect)
 *
 * Inputs are consumed at weighted-average cost; the output is valued at the
 * total input cost / actual output qty. Every ledger row carries a unique
 * sourceRef (`production:<id>:in:<material>` / `production:<id>:out`) and the
 * status guard makes completion one-shot, so posting can never happen twice.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PRODUCTION_TRANSITIONS, type ProductionStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { appendLedger, currentQuantity, getAvgCost } from "@/server/services/inventory";
import { explodeRecipe, getActiveVersion } from "@/server/services/recipe";
import { type Client, type Tx, runInTx, assertTransition, nextNumber } from "@/server/services/_workflow";
import { D, dMul, money, num, qty as roundQty } from "@/domain/money";

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

async function loadBatch(tx: Tx | PrismaClient, ctx: AccessContext, batchId: string) {
  const batch = await tx.productionBatch.findUnique({ where: { id: batchId }, include: { lines: true } });
  if (!batch || batch.organizationId !== ctx.organizationId) throw new NotFoundError("Production batch not found");
  assertOutletAccess(ctx, batch.outletId);
  assertCan(ctx, "inventory.produce", batch.outletId);
  return batch;
}

const createSchema = z.object({
  outletId: z.string(),
  recipeId: z.string(),
  plannedQty: z.number().positive(),
  batchNo: z.string().max(60).optional(),
  expiryDate: z.coerce.date().optional(),
});

/** Plan a batch from the SUB_RECIPE version in effect; input lines are the exploded raw requirements. */
export async function createProductionBatch(ctx: AccessContext, input: z.input<typeof createSchema>, db: Client = prisma) {
  const data = createSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "inventory.produce", data.outletId);
  return runInTx(db, async (tx) => {
    const outlet = await tx.outlet.findUnique({ where: { id: data.outletId }, select: { organizationId: true } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
    const recipe = await tx.recipe.findUnique({ where: { id: data.recipeId } });
    if (!recipe || recipe.organizationId !== ctx.organizationId) throw new NotFoundError("Recipe not found");
    if (recipe.outputType !== "SUB_RECIPE" || !recipe.outputMaterialId) throw new ValidationError("Only SUB_RECIPE recipes with an output material can be produced");
    const version = await getActiveVersion(tx, ctx, recipe.id);
    const requirements = await explodeRecipe(tx, ctx, version.id, data.plannedQty);
    const number = await nextNumber(tx, tx.productionBatch, { outletId: data.outletId }, "PRD");
    const batch = await tx.productionBatch.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, number, recipeVersionId: version.id, outputMaterialId: recipe.outputMaterialId,
        plannedQty: D(data.plannedQty), batchNo: data.batchNo, expiryDate: data.expiryDate, status: "DRAFT", createdById: actor(ctx),
        lines: { create: [...requirements].map(([materialId, q]) => ({ organizationId: ctx.organizationId, materialId, qty: roundQty(q) })) },
      },
      include: { lines: true },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "ProductionBatch", entityId: batch.id, outletId: data.outletId, after: { recipeVersionId: version.id, plannedQty: data.plannedQty } });
    return batch;
  });
}

export async function startProductionBatch(ctx: AccessContext, batchId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const batch = await loadBatch(tx, ctx, batchId);
    assertTransition(PRODUCTION_TRANSITIONS, batch.status as ProductionStatus, "IN_PROGRESS", "production");
    const updated = await tx.productionBatch.update({ where: { id: batchId }, data: { status: "IN_PROGRESS" } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "ProductionBatch", entityId: batchId, outletId: batch.outletId, before: { status: batch.status }, after: { status: "IN_PROGRESS" } });
    return updated;
  });
}

const completeSchema = z.object({
  actualQty: z.number().positive(),
  /** Actual quantities used, if different from the plan (materials must be planned inputs). */
  consumed: z.array(z.object({ materialId: z.string(), qty: z.number().nonnegative() })).optional(),
});

/**
 * Complete the batch: consume inputs and produce output in one transaction.
 * Rejects (without any stock effect) if any input exceeds on-hand stock.
 */
export async function completeProductionBatch(ctx: AccessContext, batchId: string, input: z.input<typeof completeSchema>, db: Client = prisma) {
  const data = completeSchema.parse(input);
  return runInTx(db, async (tx) => {
    const batch = await loadBatch(tx, ctx, batchId);
    assertTransition(PRODUCTION_TRANSITIONS, batch.status as ProductionStatus, "COMPLETED", "production");
    const overrides = new Map((data.consumed ?? []).map((c) => [c.materialId, D(c.qty)]));
    for (const id of overrides.keys()) if (!batch.lines.some((l) => l.materialId === id)) throw new ValidationError(`Material ${id} is not an input of this batch`);

    const inputs = batch.lines.map((l) => ({ line: l, qty: overrides.get(l.materialId) ?? D(l.qty) })).filter((i) => i.qty.gt(0));
    const shortages: string[] = [];
    for (const i of inputs) {
      const onHand = await currentQuantity(tx, ctx, batch.outletId, i.line.materialId);
      if (onHand.lt(i.qty)) shortages.push(`${i.line.materialId}: need ${num(i.qty)}, have ${num(onHand)}`);
    }
    if (shortages.length) throw new ValidationError(`Insufficient stock for production: ${shortages.join("; ")}`);

    let inputCost = D(0);
    for (const i of inputs) {
      const rate = await getAvgCost(tx, ctx, batch.outletId, i.line.materialId);
      await appendLedger(tx, ctx, {
        outletId: batch.outletId, materialId: i.line.materialId, magnitude: i.qty, rate, txnType: "PRODUCTION_CONSUMPTION",
        sourceType: "PRODUCTION", sourceId: batch.id, sourceRef: `production:${batch.id}:in:${i.line.materialId}`, note: `Production ${batch.number}`,
      });
      inputCost = inputCost.plus(dMul(i.qty, rate));
      if (overrides.has(i.line.materialId)) await tx.productionLine.update({ where: { id: i.line.id }, data: { qty: i.qty } });
    }
    const outputRate = money(inputCost.div(data.actualQty));
    await appendLedger(tx, ctx, {
      outletId: batch.outletId, materialId: batch.outputMaterialId, magnitude: data.actualQty, rate: outputRate, txnType: "PRODUCTION_OUTPUT",
      sourceType: "PRODUCTION", sourceId: batch.id, sourceRef: `production:${batch.id}:out`, batchNo: batch.batchNo ?? undefined, expiryDate: batch.expiryDate ?? undefined, note: `Production ${batch.number}`,
    });
    const updated = await tx.productionBatch.update({ where: { id: batchId }, data: { status: "COMPLETED", actualQty: D(data.actualQty), completedAt: new Date() } });
    await writeAudit(tx, ctx, {
      action: "INVENTORY_MOVEMENT", entityType: "ProductionBatch", entityId: batchId, outletId: batch.outletId, before: { status: batch.status },
      after: { status: "COMPLETED", actualQty: data.actualQty, plannedQty: num(batch.plannedQty), inputCost: num(money(inputCost)), outputRate: num(outputRate) },
    });
    return { batch: updated, inputCost: num(money(inputCost)), outputRate: num(outputRate) };
  });
}

export async function cancelProductionBatch(ctx: AccessContext, batchId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const batch = await loadBatch(tx, ctx, batchId);
    assertTransition(PRODUCTION_TRANSITIONS, batch.status as ProductionStatus, "CANCELLED", "production");
    const updated = await tx.productionBatch.update({ where: { id: batchId }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "ProductionBatch", entityId: batchId, outletId: batch.outletId, before: { status: batch.status }, after: { status: "CANCELLED" } });
    return updated;
  });
}

export async function listProductionBatches(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; status?: ProductionStatus; take?: number; cursor?: string }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "inventory.view", filter.outletId);
  const take = Math.min(filter.take ?? 50, 200);
  const rows = await db.productionBatch.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { lines: true },
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}
