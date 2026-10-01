/**
 * Inventory domain service — the single writer of the inventory ledger.
 *
 * Design rules (enforced here, tested in tests/):
 * - The ledger is append-only. `qty` is signed: + = stock in, - = stock out.
 * - On-hand stock is ALWAYS derived from the ledger, never stored as an
 *   editable number.
 * - Every write validates input, authorizes the actor, runs in a transaction,
 *   and (for external events) carries a unique `sourceRef` so a duplicate event
 *   is rejected by the DB and can never consume stock twice.
 * - Weighted-average cost is maintained per outlet in OutletMaterialCost.
 * - Mistakes are corrected with `recordCorrection`, never by editing/deleting.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  InventoryTransactionType,
  InventorySourceType,
  INVENTORY_INFLOW_TYPES,
  type InventoryTransactionType as TxnType,
} from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { runInTx } from "@/server/services/_workflow";
import { type AccessContext, assertOutletAccess, ValidationError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan, type Permission } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { D, dMul, qty as roundQty, money } from "@/domain/money";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

// ------------------------------------------------------------
// Core append: the ONLY function that inserts ledger rows.
// ------------------------------------------------------------

const positiveQty = z
  .union([z.number(), z.string(), z.instanceof(Prisma.Decimal)])
  .refine((v) => new Prisma.Decimal(v).gt(0), "Quantity must be greater than zero");

export type LedgerEntryInput = {
  outletId: string;
  materialId: string;
  departmentId?: string | null;
  unitId?: string | null;
  txnType: TxnType;
  /** Absolute magnitude; sign is applied from txnType direction. */
  magnitude: Prisma.Decimal | number | string;
  /** Explicit sign override for signed types (COUNT_ADJUSTMENT, RETURN, OTHER_ADJUSTMENT). */
  direction?: "IN" | "OUT";
  rate?: Prisma.Decimal | number | string;
  sourceType?: (typeof InventorySourceType.values)[number];
  sourceId?: string;
  /** Unique idempotency key for external/business events. */
  sourceRef?: string;
  batchNo?: string;
  expiryDate?: Date;
  note?: string;
  correctionOfId?: string;
};

function signedQty(txnType: TxnType, magnitude: Prisma.Decimal, direction?: "IN" | "OUT"): Prisma.Decimal {
  const abs = magnitude.abs();
  if (direction) return direction === "IN" ? abs : abs.neg();
  return INVENTORY_INFLOW_TYPES.has(txnType) ? abs : abs.neg();
}

/**
 * Low-level append used by all higher-level operations. Assumes authorization
 * has already been checked by the caller. Updates weighted-average cost on
 * inflows that carry a rate.
 */
export async function appendLedger(tx: Tx, ctx: AccessContext, input: LedgerEntryInput) {
  await assertOutletInOrg(tx, ctx, input.outletId); // every ledger row's outlet must belong to the caller's org
  const magnitude = D(input.magnitude);
  if (magnitude.lte(0)) throw new ValidationError("Quantity must be greater than zero");

  const signed = roundQty(signedQty(input.txnType, magnitude, input.direction));
  const rate = input.rate !== undefined ? D(input.rate) : D(0);
  const amount = money(dMul(signed, rate));

  const row = await tx.inventoryLedger.create({
    data: {
      organizationId: ctx.organizationId,
      outletId: input.outletId,
      departmentId: input.departmentId ?? null,
      materialId: input.materialId,
      unitId: input.unitId ?? null,
      txnType: input.txnType,
      qty: signed,
      rate,
      amount,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      sourceRef: input.sourceRef ?? null,
      batchNo: input.batchNo ?? null,
      expiryDate: input.expiryDate ?? null,
      note: input.note ?? null,
      correctionOfId: input.correctionOfId ?? null,
      actorId: ctx.userId === "system" ? null : ctx.userId,
    },
  });

  // Maintain weighted-average cost for inflows that provide a rate.
  if (signed.gt(0) && rate.gt(0)) {
    await updateWeightedAverageCost(tx, ctx, input.outletId, input.materialId, signed, rate);
  }

  return row;
}

async function updateWeightedAverageCost(
  tx: Tx,
  ctx: AccessContext,
  outletId: string,
  materialId: string,
  inflowQty: Prisma.Decimal,
  inflowRate: Prisma.Decimal
) {
  // Quantity on hand BEFORE this inflow (this row is already inserted, so
  // subtract it back out to get the prior balance).
  const agg = await tx.inventoryLedger.aggregate({
    where: { organizationId: ctx.organizationId, outletId, materialId },
    _sum: { qty: true },
  });
  const balanceAfter = D(agg._sum.qty ?? 0);
  const priorQty = balanceAfter.minus(inflowQty);

  const existing = await tx.outletMaterialCost.findUnique({
    where: { outletId_materialId: { outletId, materialId } },
  });
  const priorAvg = existing ? D(existing.avgCost) : D(0);

  // weighted average = (priorQty*priorAvg + inflowQty*inflowRate) / (priorQty+inflowQty)
  const denom = priorQty.plus(inflowQty);
  const newAvg =
    denom.lte(0) ? inflowRate : priorQty.times(priorAvg).plus(inflowQty.times(inflowRate)).div(denom);

  await tx.outletMaterialCost.upsert({
    where: { outletId_materialId: { outletId, materialId } },
    create: {
      organizationId: ctx.organizationId,
      outletId,
      materialId,
      avgCost: money(newAvg),
      lastCost: money(inflowRate),
    },
    update: { avgCost: money(newAvg), lastCost: money(inflowRate) },
  });
}

/** Get the current weighted-average cost of a material at an outlet. */
export async function getAvgCost(db: Client, ctx: AccessContext, outletId: string, materialId: string): Promise<Prisma.Decimal> {
  const rec = await db.outletMaterialCost.findUnique({
    where: { outletId_materialId: { outletId, materialId } },
  });
  return rec ? D(rec.avgCost) : D(0);
}

// ------------------------------------------------------------
// Public operations (validate + authorize + transact)
// ------------------------------------------------------------

function requirePermission(ctx: AccessContext, perm: Permission, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, perm, outletId);
}

// Transactions: shared runInTx (Serializable + bounded retry) from _workflow.ts.

export type ReceiptInput = {
  outletId: string;
  materialId: string;
  quantity: number | string;
  rate: number | string;
  departmentId?: string;
  unitId?: string;
  sourceId?: string;
  sourceRef?: string;
  batchNo?: string;
  expiryDate?: Date;
  note?: string;
};

export function recordPurchaseReceipt(ctx: AccessContext, input: ReceiptInput, db: Client = prisma) {
  requirePermission(ctx, "grn.create", input.outletId);
  positiveQty.parse(input.quantity);
  return runInTx(db, async (tx) => {
    const row = await appendLedger(tx, ctx, {
      ...input,
      magnitude: input.quantity,
      txnType: "PURCHASE_RECEIPT",
      sourceType: "GRN",
    });
    await writeAudit(tx, ctx, {
      action: "INVENTORY_MOVEMENT",
      entityType: "InventoryLedger",
      entityId: row.id,
      outletId: input.outletId,
      after: { txnType: "PURCHASE_RECEIPT", qty: row.qty, materialId: input.materialId },
    });
    return row;
  });
}

export type ConsumptionInput = {
  outletId: string;
  materialId: string;
  quantity: number | string;
  departmentId?: string;
  unitId?: string;
  sourceType?: (typeof InventorySourceType.values)[number];
  sourceId?: string;
  sourceRef?: string;
  note?: string;
  /** rate for costing; defaults to current weighted-average cost. */
  rate?: number | string;
};

export function recordSaleConsumption(ctx: AccessContext, input: ConsumptionInput, db: Client = prisma) {
  positiveQty.parse(input.quantity);
  return runInTx(db, async (tx) => {
    const rate = input.rate !== undefined ? D(input.rate) : await getAvgCost(tx, ctx, input.outletId, input.materialId);
    return appendLedger(tx, ctx, {
      ...input,
      magnitude: input.quantity,
      rate,
      txnType: "SALE_CONSUMPTION",
      sourceType: input.sourceType ?? "ORDER",
    });
  });
}

export type IssueInput = {
  outletId: string;
  materialId: string;
  quantity: number | string;
  fromDepartmentId?: string;
  unitId?: string;
  sourceId?: string;
  sourceRef?: string;
  note?: string;
};

export function recordIssue(ctx: AccessContext, input: IssueInput, db: Client = prisma) {
  requirePermission(ctx, "inventory.issue", input.outletId);
  positiveQty.parse(input.quantity);
  return runInTx(db, async (tx) => {
    const rate = await getAvgCost(tx, ctx, input.outletId, input.materialId);
    const row = await appendLedger(tx, ctx, {
      outletId: input.outletId,
      materialId: input.materialId,
      departmentId: input.fromDepartmentId,
      unitId: input.unitId,
      magnitude: input.quantity,
      rate,
      txnType: "ISSUE",
      sourceType: "ISSUE",
      sourceId: input.sourceId,
      sourceRef: input.sourceRef,
      note: input.note,
    });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "InventoryLedger", entityId: row.id, outletId: input.outletId, after: { txnType: "ISSUE" } });
    return row;
  });
}

export type TransferInput = {
  fromOutletId: string;
  toOutletId: string;
  materialId: string;
  quantity: number | string;
  unitId?: string;
  sourceId?: string;
  /** base ref; TRANSFER_OUT/IN get suffixes so both rows are unique. */
  sourceRef?: string;
  note?: string;
};

/** Transfer stock between outlets: one TRANSFER_OUT and one TRANSFER_IN row. */
export function recordTransfer(ctx: AccessContext, input: TransferInput, db: Client = prisma) {
  requirePermission(ctx, "inventory.transfer", input.fromOutletId);
  assertOutletAccess(ctx, input.toOutletId);
  positiveQty.parse(input.quantity);
  if (input.fromOutletId === input.toOutletId) throw new ValidationError("Cannot transfer to the same outlet");
  return runInTx(db, async (tx) => {
    const rate = await getAvgCost(tx, ctx, input.fromOutletId, input.materialId);
    const out = await appendLedger(tx, ctx, {
      outletId: input.fromOutletId,
      materialId: input.materialId,
      unitId: input.unitId,
      magnitude: input.quantity,
      rate,
      txnType: "TRANSFER_OUT",
      sourceType: "TRANSFER",
      sourceId: input.sourceId,
      sourceRef: input.sourceRef ? `${input.sourceRef}:out` : undefined,
      note: input.note,
    });
    const inn = await appendLedger(tx, ctx, {
      outletId: input.toOutletId,
      materialId: input.materialId,
      unitId: input.unitId,
      magnitude: input.quantity,
      rate, // carry source-outlet cost to receiving outlet
      txnType: "TRANSFER_IN",
      sourceType: "TRANSFER",
      sourceId: input.sourceId,
      sourceRef: input.sourceRef ? `${input.sourceRef}:in` : undefined,
      note: input.note,
    });
    return { out, in: inn };
  });
}

export type WastageInput = {
  outletId: string;
  materialId: string;
  quantity: number | string;
  departmentId?: string;
  unitId?: string;
  sourceId?: string;
  sourceRef?: string;
  note?: string;
};

export function recordWastage(ctx: AccessContext, input: WastageInput, db: Client = prisma) {
  requirePermission(ctx, "inventory.wastage", input.outletId);
  positiveQty.parse(input.quantity);
  return runInTx(db, async (tx) => {
    const rate = await getAvgCost(tx, ctx, input.outletId, input.materialId);
    const row = await appendLedger(tx, ctx, {
      ...input,
      magnitude: input.quantity,
      rate,
      txnType: "WASTAGE",
      sourceType: "WASTAGE",
    });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "InventoryLedger", entityId: row.id, outletId: input.outletId, after: { txnType: "WASTAGE" } });
    return row;
  });
}

export type ProductionOutputInput = {
  outletId: string;
  materialId: string;
  quantity: number | string;
  rate: number | string; // computed cost per unit of produced good
  batchNo?: string;
  expiryDate?: Date;
  sourceId?: string;
  sourceRef?: string;
};

export function recordProductionOutput(ctx: AccessContext, input: ProductionOutputInput, db: Client = prisma) {
  requirePermission(ctx, "inventory.produce", input.outletId);
  positiveQty.parse(input.quantity);
  return runInTx(db, (tx) =>
    appendLedger(tx, ctx, { ...input, magnitude: input.quantity, txnType: "PRODUCTION_OUTPUT", sourceType: "PRODUCTION" })
  );
}

export type ProductionConsumptionInput = {
  outletId: string;
  materialId: string;
  quantity: number | string;
  sourceId?: string;
  sourceRef?: string;
};

export function recordProductionConsumption(ctx: AccessContext, input: ProductionConsumptionInput, db: Client = prisma) {
  requirePermission(ctx, "inventory.produce", input.outletId);
  positiveQty.parse(input.quantity);
  return runInTx(db, async (tx) => {
    const rate = await getAvgCost(tx, ctx, input.outletId, input.materialId);
    return appendLedger(tx, ctx, {
      ...input,
      magnitude: input.quantity,
      rate,
      txnType: "PRODUCTION_CONSUMPTION",
      sourceType: "PRODUCTION",
    });
  });
}

export type CountAdjustmentInput = {
  outletId: string;
  materialId: string;
  /** signed difference physical-book: positive => stock up, negative => down */
  variance: number | string;
  unitId?: string;
  sourceId?: string;
  sourceRef?: string;
  note?: string;
};

export function recordCountAdjustment(ctx: AccessContext, input: CountAdjustmentInput, db: Client = prisma) {
  requirePermission(ctx, "inventory.approve_adjustment", input.outletId);
  const v = D(input.variance);
  if (v.isZero()) throw new ValidationError("Variance is zero — nothing to adjust");
  return runInTx(db, async (tx) => {
    const rate = await getAvgCost(tx, ctx, input.outletId, input.materialId);
    const row = await appendLedger(tx, ctx, {
      outletId: input.outletId,
      materialId: input.materialId,
      unitId: input.unitId,
      magnitude: v.abs(),
      direction: v.gt(0) ? "IN" : "OUT",
      rate,
      txnType: "COUNT_ADJUSTMENT",
      sourceType: "COUNT",
      sourceId: input.sourceId,
      sourceRef: input.sourceRef,
      note: input.note,
    });
    await writeAudit(tx, ctx, { action: "STOCK_ADJUSTMENT", entityType: "InventoryLedger", entityId: row.id, outletId: input.outletId, after: { variance: input.variance } });
    return row;
  });
}

export type ReturnInput = {
  outletId: string;
  materialId: string;
  quantity: number | string;
  /** IN = returned into stock (default), OUT = returned to vendor */
  direction?: "IN" | "OUT";
  unitId?: string;
  sourceId?: string;
  sourceRef?: string;
  note?: string;
};

export function recordReturn(ctx: AccessContext, input: ReturnInput, db: Client = prisma) {
  requirePermission(ctx, "inventory.adjust", input.outletId);
  positiveQty.parse(input.quantity);
  return runInTx(db, async (tx) => {
    const rate = await getAvgCost(tx, ctx, input.outletId, input.materialId);
    return appendLedger(tx, ctx, {
      ...input,
      magnitude: input.quantity,
      direction: input.direction ?? "IN",
      rate,
      txnType: "RETURN",
      sourceType: "MANUAL",
    });
  });
}

/** Post an opening balance (used by seeding / outlet setup). */
export function recordOpeningBalance(
  ctx: AccessContext,
  input: { outletId: string; materialId: string; quantity: number | string; rate: number | string; unitId?: string; sourceRef?: string },
  db: Client = prisma
) {
  positiveQty.parse(input.quantity);
  return runInTx(db, (tx) =>
    appendLedger(tx, ctx, { ...input, magnitude: input.quantity, txnType: "OPENING_BALANCE", sourceType: "MANUAL" })
  );
}

/**
 * Correct a previous ledger row by appending an equal-and-opposite entry
 * (append-only correction, never edit/delete).
 */
export function recordCorrection(ctx: AccessContext, ledgerId: string, note: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const orig = await tx.inventoryLedger.findUnique({ where: { id: ledgerId } });
    if (!orig || orig.organizationId !== ctx.organizationId) throw new ValidationError("Ledger row not found");
    requirePermission(ctx, "inventory.adjust", orig.outletId);
    const reverseQty = D(orig.qty).neg();
    const row = await tx.inventoryLedger.create({
      data: {
        organizationId: orig.organizationId,
        outletId: orig.outletId,
        departmentId: orig.departmentId,
        materialId: orig.materialId,
        unitId: orig.unitId,
        txnType: "OTHER_ADJUSTMENT",
        qty: reverseQty,
        rate: orig.rate,
        amount: money(dMul(reverseQty, orig.rate)),
        sourceType: "MANUAL",
        note: `Correction of ${orig.id}: ${note}`,
        correctionOfId: orig.id,
        actorId: ctx.userId === "system" ? null : ctx.userId,
      },
    });
    await writeAudit(tx, ctx, { action: "STOCK_ADJUSTMENT", entityType: "InventoryLedger", entityId: row.id, outletId: orig.outletId, before: { original: orig.id }, after: { correction: row.id } });
    return row;
  });
}

// ------------------------------------------------------------
// Balance & reporting queries (all derived from the ledger)
// ------------------------------------------------------------

export async function currentQuantity(db: Client, ctx: AccessContext, outletId: string, materialId: string): Promise<Prisma.Decimal> {
  const agg = await db.inventoryLedger.aggregate({
    where: { organizationId: ctx.organizationId, outletId, materialId },
    _sum: { qty: true },
  });
  return D(agg._sum.qty ?? 0);
}

export type StockRow = { materialId: string; quantity: Prisma.Decimal; avgCost: Prisma.Decimal; value: Prisma.Decimal };

/** On-hand quantity + value for every material at an outlet. */
export async function stockByOutlet(db: Client, ctx: AccessContext, outletId: string): Promise<StockRow[]> {
  const grouped = await db.inventoryLedger.groupBy({
    by: ["materialId"],
    where: { organizationId: ctx.organizationId, outletId },
    _sum: { qty: true },
  });
  const costs = await db.outletMaterialCost.findMany({ where: { organizationId: ctx.organizationId, outletId } });
  const costMap = new Map(costs.map((c) => [c.materialId, D(c.avgCost)]));
  return grouped.map((g) => {
    const quantity = D(g._sum.qty ?? 0);
    const avgCost = costMap.get(g.materialId) ?? D(0);
    return { materialId: g.materialId, quantity, avgCost, value: money(dMul(quantity, avgCost)) };
  });
}

/** On-hand grouped by department at an outlet. */
export async function stockByDepartment(db: Client, ctx: AccessContext, outletId: string) {
  return db.inventoryLedger.groupBy({
    by: ["departmentId", "materialId"],
    where: { organizationId: ctx.organizationId, outletId },
    _sum: { qty: true },
  });
}

/** Total stock value at an outlet. */
export async function stockValue(db: Client, ctx: AccessContext, outletId: string): Promise<Prisma.Decimal> {
  const rows = await stockByOutlet(db, ctx, outletId);
  return rows.reduce((acc, r) => acc.plus(r.value), D(0));
}

/** Recent movements for a material (audit / history view). */
export function stockMovement(db: Client, ctx: AccessContext, outletId: string, materialId: string, take = 100) {
  return db.inventoryLedger.findMany({
    where: { organizationId: ctx.organizationId, outletId, materialId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

/** Materials at or below their reorder level. */
export async function lowStock(db: Client, ctx: AccessContext, outletId: string) {
  const rows = await stockByOutlet(db, ctx, outletId);
  const materials = await db.material.findMany({ where: { organizationId: ctx.organizationId, active: true } });
  const stockMap = new Map(rows.map((r) => [r.materialId, r.quantity]));
  return materials
    .map((m) => ({ material: m, quantity: stockMap.get(m.id) ?? D(0), reorderLevel: D(m.reorderLevel) }))
    .filter((r) => r.reorderLevel.gt(0) && r.quantity.lte(r.reorderLevel));
}

/** Materials with negative on-hand (data-integrity anomaly). */
export async function negativeStock(db: Client, ctx: AccessContext, outletId?: string) {
  const grouped = await db.inventoryLedger.groupBy({
    by: ["outletId", "materialId"],
    where: { organizationId: ctx.organizationId, ...(outletId ? { outletId } : {}) },
    _sum: { qty: true },
  });
  return grouped.filter((g) => D(g._sum.qty ?? 0).lt(0)).map((g) => ({ outletId: g.outletId, materialId: g.materialId, quantity: D(g._sum.qty ?? 0) }));
}
