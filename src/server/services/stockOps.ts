/**
 * Stock operation workflow services: Inventory Transfer, Inventory Issue,
 * Stock Count. Each posts to the append-only ledger transactionally with state
 * validation, permission + scope checks, and audit rows. Ledger writes carry a
 * unique sourceRef so re-running a posting cannot double-move stock.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  TRANSFER_TRANSITIONS,
  ISSUE_TRANSITIONS,
  STOCK_COUNT_TRANSITIONS,
  type TransferStatus,
  type IssueStatus,
  type StockCountStatus,
} from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { appendLedger, assertAvailable, getAvgCost, recordCountAdjustment, resolveUnit, toBaseUnits } from "@/server/services/inventory";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { idempotentCreate, requestHashOf } from "@/server/services/idempotency";
import { D, dMul, money } from "@/domain/money";
import { type Client, type Tx, runInTx, assertTransition, nextNumber } from "@/server/services/_workflow";

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

// ============================================================
// Inventory Transfer (outlet -> outlet)
// ============================================================

const qtyNum = z.number().positive().max(1_000_000_000);
const transferSchema = z.object({
  fromOutletId: z.string(),
  toOutletId: z.string(),
  number: z.string().optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object({ materialId: z.string(), requestedQty: qtyNum, unitId: z.string().optional() })).min(1).max(200),
});

/** Every line's material belongs to the org and its unit converts to the material's base unit. */
async function validateLines(tx: Tx, ctx: AccessContext, lines: Array<{ materialId: string; unitId?: string | null }>) {
  for (const l of lines) await resolveUnit(tx, ctx, l.materialId, l.unitId);
}

export async function createTransfer(ctx: AccessContext, input: z.input<typeof transferSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = transferSchema.parse(input);
  if (data.fromOutletId === data.toOutletId) throw new ValidationError("Cannot transfer to the same outlet");
  assertOutletAccess(ctx, data.fromOutletId);
  assertOutletAccess(ctx, data.toOutletId);
  assertCan(ctx, "inventory.transfer", data.fromOutletId);
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "transfer", data),
    findPrior: (key) => prisma.inventoryTransfer.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      await assertOutletInOrg(tx, ctx, data.fromOutletId);
      await assertOutletInOrg(tx, ctx, data.toOutletId);
      await validateLines(tx, ctx, data.lines);
      const number = data.number ?? (await nextNumber(tx, tx.inventoryTransfer, { organizationId: ctx.organizationId }, "TRF"));
      const transfer = await tx.inventoryTransfer.create({
        data: {
          organizationId: ctx.organizationId, number, fromOutletId: data.fromOutletId, toOutletId: data.toOutletId, status: "DRAFT", notes: data.notes, createdById: actor(ctx), idempotencyKey: key, requestHash: hash,
          lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, requestedQty: l.requestedQty, unitId: l.unitId })) },
        },
      });
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "InventoryTransfer", entityId: transfer.id, outletId: data.fromOutletId });
      return transfer;
    }),
  });
}

/**
 * DRAFT -> DISPATCHED. Line quantities are in the line's unit; the ledger gets
 * base units. A dispatched quantity may be lower than requested, never higher,
 * and never more than the source outlet holds (all lines of a material together).
 */
export function dispatchTransfer(ctx: AccessContext, transferId: string, overrides?: Array<{ lineId: string; dispatchedQty: number }>, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const transfer = await tx.inventoryTransfer.findUnique({ where: { id: transferId }, include: { lines: true } });
    if (!transfer || transfer.organizationId !== ctx.organizationId) throw new NotFoundError("Transfer not found");
    assertOutletAccess(ctx, transfer.fromOutletId);
    assertCan(ctx, "inventory.transfer", transfer.fromOutletId);
    assertTransition(TRANSFER_TRANSITIONS, transfer.status as TransferStatus, "DISPATCHED", "transfer");
    const overrideMap = new Map((overrides ?? []).map((o) => [o.lineId, o.dispatchedQty]));
    for (const id of overrideMap.keys()) if (!transfer.lines.some((l) => l.id === id)) throw new ValidationError(`Line ${id} is not part of this transfer`);
    const plan = [];
    const need = new Map<string, Prisma.Decimal>();
    for (const line of transfer.lines) {
      const qty = D(overrideMap.get(line.id) ?? line.requestedQty);
      if (qty.lt(0)) throw new ValidationError("Dispatched quantity cannot be negative");
      if (qty.gt(D(line.requestedQty))) throw new ValidationError(`Cannot dispatch more than requested (${line.requestedQty.toString()}) for line ${line.id}`);
      const base = await toBaseUnits(tx, ctx, line.materialId, qty, line.unitId);
      plan.push({ line, qty, base });
      if (base.qty.gt(0)) need.set(line.materialId, (need.get(line.materialId) ?? D(0)).plus(base.qty));
    }
    await assertAvailable(tx, ctx, transfer.fromOutletId, need);
    for (const { line, qty, base } of plan) {
      if (base.qty.gt(0)) {
        const rate = await getAvgCost(tx, ctx, transfer.fromOutletId, line.materialId);
        await appendLedger(tx, ctx, {
          outletId: transfer.fromOutletId, materialId: line.materialId, unitId: base.baseUnitId, magnitude: base.qty, rate,
          txnType: "TRANSFER_OUT", sourceType: "TRANSFER", sourceId: transfer.id, sourceRef: `transfer:${transfer.id}:out:${line.id}`,
        });
      }
      await tx.inventoryTransferLine.update({ where: { id: line.id }, data: { dispatchedQty: qty } });
    }
    const updated = await tx.inventoryTransfer.update({ where: { id: transferId }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "InventoryTransfer", entityId: transferId, outletId: transfer.fromOutletId, after: { status: "DISPATCHED", lines: plan.map((p) => ({ lineId: p.line.id, qty: p.qty.toString() })) } });
    return updated;
  });
}

/**
 * DISPATCHED -> RECEIVED at the destination. received <= dispatched and
 * damaged <= received (per line, in the line's unit); only the good quantity
 * enters the destination, at the cost it left the source with. What was
 * dispatched but not received in good condition is recorded on the line and
 * in the audit row (it already left the source's books at dispatch).
 */
export function receiveTransfer(ctx: AccessContext, transferId: string, overrides?: Array<{ lineId: string; receivedQty: number; damagedQty?: number }>, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const transfer = await tx.inventoryTransfer.findUnique({ where: { id: transferId }, include: { lines: true } });
    if (!transfer || transfer.organizationId !== ctx.organizationId) throw new NotFoundError("Transfer not found");
    assertOutletAccess(ctx, transfer.toOutletId);
    assertCan(ctx, "inventory.transfer", transfer.toOutletId);
    assertTransition(TRANSFER_TRANSITIONS, transfer.status as TransferStatus, "RECEIVED", "transfer");
    const overrideMap = new Map((overrides ?? []).map((o) => [o.lineId, o]));
    for (const id of overrideMap.keys()) if (!transfer.lines.some((l) => l.id === id)) throw new ValidationError(`Line ${id} is not part of this transfer`);
    const losses = [];
    for (const line of transfer.lines) {
      const o = overrideMap.get(line.id);
      const dispatched = D(line.dispatchedQty);
      const received = D(o?.receivedQty ?? dispatched);
      const damaged = D(o?.damagedQty ?? 0);
      if (received.lt(0) || damaged.lt(0)) throw new ValidationError("Quantities cannot be negative");
      if (received.gt(dispatched)) throw new ValidationError(`Cannot receive more than was dispatched (${dispatched.toString()}) for line ${line.id}`);
      if (damaged.gt(received)) throw new ValidationError(`Damaged quantity cannot exceed the received quantity for line ${line.id}`);
      const good = received.minus(damaged);
      if (good.gt(0)) {
        const base = await toBaseUnits(tx, ctx, line.materialId, good, line.unitId);
        // Cost travels with the goods: the rate the source booked them out at.
        const out = (await tx.inventoryLedger.findUnique({ where: { sourceRef: `transfer:${transfer.id}:out:${line.id}` } })) ??
          (await tx.inventoryLedger.findUnique({ where: { sourceRef: `transfer:${transfer.id}:out:${line.materialId}` } })); // dispatched before per-line refs
        const rate = out ? D(out.rate) : await getAvgCost(tx, ctx, transfer.fromOutletId, line.materialId);
        await appendLedger(tx, ctx, {
          outletId: transfer.toOutletId, materialId: line.materialId, unitId: base.baseUnitId, magnitude: base.qty, rate,
          txnType: "TRANSFER_IN", sourceType: "TRANSFER", sourceId: transfer.id, sourceRef: `transfer:${transfer.id}:in:${line.id}`,
        });
      }
      if (dispatched.minus(good).gt(0)) losses.push({ lineId: line.id, materialId: line.materialId, short: dispatched.minus(received).toString(), damaged: damaged.toString() });
      await tx.inventoryTransferLine.update({ where: { id: line.id }, data: { receivedQty: received, damagedQty: damaged } });
    }
    const updated = await tx.inventoryTransfer.update({ where: { id: transferId }, data: { status: "RECEIVED", receivedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "InventoryTransfer", entityId: transferId, outletId: transfer.toOutletId, after: { status: "RECEIVED", losses } });
    return updated;
  });
}

export function cancelTransfer(ctx: AccessContext, transferId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const transfer = await tx.inventoryTransfer.findUnique({ where: { id: transferId } });
    if (!transfer || transfer.organizationId !== ctx.organizationId) throw new NotFoundError("Transfer not found");
    assertOutletAccess(ctx, transfer.fromOutletId);
    assertCan(ctx, "inventory.transfer", transfer.fromOutletId);
    assertTransition(TRANSFER_TRANSITIONS, transfer.status as TransferStatus, "CANCELLED", "transfer");
    const updated = await tx.inventoryTransfer.update({ where: { id: transferId }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "InventoryTransfer", entityId: transferId, outletId: transfer.fromOutletId });
    return updated;
  });
}

// ============================================================
// Inventory Issue (store -> kitchen etc.)
// ============================================================

const issueSchema = z.object({
  outletId: z.string(),
  number: z.string().optional(),
  fromDepartmentId: z.string().optional(),
  toDepartmentId: z.string().optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: qtyNum, unitId: z.string().optional() })).min(1).max(200),
});

export async function createIssue(ctx: AccessContext, input: z.input<typeof issueSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = issueSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "inventory.issue", data.outletId);
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "issue", data),
    findPrior: (key) => prisma.inventoryIssue.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      await assertOutletInOrg(tx, ctx, data.outletId);
      for (const deptId of [data.fromDepartmentId, data.toDepartmentId]) {
        if (!deptId) continue;
        const dept = await tx.department.findUnique({ where: { id: deptId } });
        if (!dept || dept.outletId !== data.outletId) throw new ValidationError("Department not in this outlet");
      }
      await validateLines(tx, ctx, data.lines);
      const number = data.number ?? (await nextNumber(tx, tx.inventoryIssue, { outletId: data.outletId }, "ISS"));
      const issue = await tx.inventoryIssue.create({
        data: {
          organizationId: ctx.organizationId, outletId: data.outletId, number, fromDepartmentId: data.fromDepartmentId, toDepartmentId: data.toDepartmentId, status: "DRAFT", notes: data.notes, createdById: actor(ctx), idempotencyKey: key, requestHash: hash,
          lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, unitId: l.unitId })) },
        },
      });
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "InventoryIssue", entityId: issue.id, outletId: data.outletId });
      return issue;
    }),
  });
}

/** DRAFT -> ISSUED: one ISSUE row per line in base units; refused (no effect) if any material is short. */
export function postIssue(ctx: AccessContext, issueId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const issue = await tx.inventoryIssue.findUnique({ where: { id: issueId }, include: { lines: true } });
    if (!issue || issue.organizationId !== ctx.organizationId) throw new NotFoundError("Issue not found");
    assertOutletAccess(ctx, issue.outletId);
    assertCan(ctx, "inventory.issue", issue.outletId);
    if (issue.status === "ISSUED") return issue; // idempotent
    assertTransition(ISSUE_TRANSITIONS, issue.status as IssueStatus, "ISSUED", "issue");
    const plan = [];
    const need = new Map<string, Prisma.Decimal>();
    for (const line of issue.lines) {
      const base = await toBaseUnits(tx, ctx, line.materialId, line.qty, line.unitId);
      plan.push({ line, base });
      need.set(line.materialId, (need.get(line.materialId) ?? D(0)).plus(base.qty));
    }
    await assertAvailable(tx, ctx, issue.outletId, need);
    for (const { line, base } of plan) {
      const rate = await getAvgCost(tx, ctx, issue.outletId, line.materialId);
      await appendLedger(tx, ctx, {
        outletId: issue.outletId, materialId: line.materialId, departmentId: issue.fromDepartmentId ?? undefined, unitId: base.baseUnitId, magnitude: base.qty, rate,
        txnType: "ISSUE", sourceType: "ISSUE", sourceId: issue.id, sourceRef: `issue:${issue.id}:${line.id}`,
      });
    }
    const updated = await tx.inventoryIssue.update({ where: { id: issueId }, data: { status: "ISSUED", issuedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "InventoryIssue", entityId: issueId, outletId: issue.outletId, after: { status: "ISSUED" } });
    return updated;
  });
}

export function cancelIssue(ctx: AccessContext, issueId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const issue = await tx.inventoryIssue.findUnique({ where: { id: issueId } });
    if (!issue || issue.organizationId !== ctx.organizationId) throw new NotFoundError("Issue not found");
    assertOutletAccess(ctx, issue.outletId);
    assertCan(ctx, "inventory.issue", issue.outletId);
    assertTransition(ISSUE_TRANSITIONS, issue.status as IssueStatus, "CANCELLED", "issue");
    const updated = await tx.inventoryIssue.update({ where: { id: issueId }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "InventoryIssue", entityId: issueId, outletId: issue.outletId });
    return updated;
  });
}

// ============================================================
// Stock Count
// ============================================================

export function createStockCount(ctx: AccessContext, input: { outletId: string; departmentId?: string; number?: string }, db: Client = prisma) {
  assertOutletAccess(ctx, input.outletId);
  assertCan(ctx, "inventory.count", input.outletId);
  return runInTx(db, async (tx) => {
    const number = input.number ?? (await nextNumber(tx, tx.stockCount, { outletId: input.outletId }, "SC"));
    const count = await tx.stockCount.create({
      data: { organizationId: ctx.organizationId, outletId: input.outletId, departmentId: input.departmentId, number, status: "DRAFT", createdById: actor(ctx) },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "StockCount", entityId: count.id, outletId: input.outletId });
    return count;
  });
}

/** DRAFT -> COUNTING: freeze book quantities into lines (snapshot, never overwritten). */
export function startStockCount(ctx: AccessContext, countId: string, opts?: { materialIds?: string[] }, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const count = await tx.stockCount.findUnique({ where: { id: countId } });
    if (!count || count.organizationId !== ctx.organizationId) throw new NotFoundError("Stock count not found");
    assertOutletAccess(ctx, count.outletId);
    assertCan(ctx, "inventory.count", count.outletId);
    assertTransition(STOCK_COUNT_TRANSITIONS, count.status as StockCountStatus, "COUNTING", "stock count");

    // Book quantities = derived balances at freeze time.
    const grouped = await tx.inventoryLedger.groupBy({
      by: ["materialId"],
      where: { organizationId: ctx.organizationId, outletId: count.outletId, ...(opts?.materialIds ? { materialId: { in: opts.materialIds } } : {}) },
      _sum: { qty: true },
    });
    const rows = opts?.materialIds
      ? opts.materialIds.map((m) => ({ materialId: m, book: D(grouped.find((g) => g.materialId === m)?._sum.qty ?? 0) }))
      : grouped.map((g) => ({ materialId: g.materialId, book: D(g._sum.qty ?? 0) }));

    for (const r of rows) {
      await tx.stockCountLine.create({
        data: { organizationId: ctx.organizationId, countId, materialId: r.materialId, bookQty: r.book.toString(), physicalQty: r.book.toString(), variance: 0, costImpact: 0 },
      });
    }
    const updated = await tx.stockCount.update({ where: { id: countId }, data: { status: "COUNTING", frozenAt: new Date() } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "StockCount", entityId: countId, outletId: count.outletId, after: { status: "COUNTING", lines: rows.length } });
    return updated;
  });
}

/**
 * Physical quantities for a COUNTING count. A count may be entered in any
 * convertible unit (e.g. crates); it is stored in the base unit, like the
 * frozen book quantity it is compared with.
 */
export function enterStockCounts(ctx: AccessContext, countId: string, entries: Array<{ materialId: string; physicalQty: number; unitId?: string }>, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const count = await tx.stockCount.findUnique({ where: { id: countId }, include: { lines: true } });
    if (!count || count.organizationId !== ctx.organizationId) throw new NotFoundError("Stock count not found");
    assertOutletAccess(ctx, count.outletId);
    assertCan(ctx, "inventory.count", count.outletId);
    if (count.status !== "COUNTING") throw new ValidationError("Stock count is not in COUNTING state");
    for (const e of entries) {
      if (!Number.isFinite(e.physicalQty) || e.physicalQty < 0) throw new ValidationError("Physical quantity cannot be negative");
      const line = count.lines.find((l) => l.materialId === e.materialId);
      if (!line) throw new ValidationError(`Material ${e.materialId} not part of this count`);
      const physical = (await toBaseUnits(tx, ctx, e.materialId, e.physicalQty, e.unitId)).qty;
      const variance = physical.minus(D(line.bookQty));
      const avg = await getAvgCost(tx, ctx, count.outletId, e.materialId);
      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { physicalQty: physical.toString(), variance: variance.toString(), costImpact: money(dMul(variance, avg)).toString() },
      });
    }
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "StockCount", entityId: countId, outletId: count.outletId, after: { entries: entries.length } });
    return tx.stockCount.findUnique({ where: { id: countId }, include: { lines: true } });
  });
}

export function submitStockCountForReview(ctx: AccessContext, countId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const count = await tx.stockCount.findUnique({ where: { id: countId } });
    if (!count || count.organizationId !== ctx.organizationId) throw new NotFoundError("Stock count not found");
    assertOutletAccess(ctx, count.outletId);
    assertCan(ctx, "inventory.count", count.outletId);
    assertTransition(STOCK_COUNT_TRANSITIONS, count.status as StockCountStatus, "REVIEW", "stock count");
    return tx.stockCount.update({ where: { id: countId }, data: { status: "REVIEW" } });
  });
}

/** REVIEW -> APPROVED: post COUNT_ADJUSTMENT for each non-zero variance. Idempotent. */
export function approveStockCount(ctx: AccessContext, countId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const count = await tx.stockCount.findUnique({ where: { id: countId }, include: { lines: true } });
    if (!count || count.organizationId !== ctx.organizationId) throw new NotFoundError("Stock count not found");
    assertOutletAccess(ctx, count.outletId);
    assertCan(ctx, "inventory.approve_adjustment", count.outletId);
    assertTransition(STOCK_COUNT_TRANSITIONS, count.status as StockCountStatus, "APPROVED", "stock count");
    for (const line of count.lines) {
      const variance = D(line.variance);
      if (!variance.isZero()) {
        await recordCountAdjustment(ctx, {
          outletId: count.outletId, materialId: line.materialId, variance: variance.toString(),
          sourceId: count.id, sourceRef: `count:${count.id}:${line.materialId}`, note: `Stock count ${count.number}`,
        }, tx);
      }
    }
    const updated = await tx.stockCount.update({ where: { id: countId }, data: { status: "APPROVED", approvedById: actor(ctx), approvedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "STOCK_ADJUSTMENT", entityType: "StockCount", entityId: countId, outletId: count.outletId, after: { status: "APPROVED" } });
    return updated;
  });
}

export function cancelStockCount(ctx: AccessContext, countId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const count = await tx.stockCount.findUnique({ where: { id: countId } });
    if (!count || count.organizationId !== ctx.organizationId) throw new NotFoundError("Stock count not found");
    assertOutletAccess(ctx, count.outletId);
    assertCan(ctx, "inventory.count", count.outletId);
    assertTransition(STOCK_COUNT_TRANSITIONS, count.status as StockCountStatus, "CANCELLED", "stock count");
    return tx.stockCount.update({ where: { id: countId }, data: { status: "CANCELLED" } });
  });
}
