/**
 * Stock operation workflow services: Inventory Transfer, Inventory Issue,
 * Stock Count. Each posts to the append-only ledger transactionally with state
 * validation, permission + scope checks, and audit rows. Ledger writes carry a
 * unique sourceRef so re-running a posting cannot double-move stock.
 */
import { type PrismaClient } from "@prisma/client";
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
import { appendLedger, getAvgCost, recordCountAdjustment } from "@/server/services/inventory";
import { D, dMul, money } from "@/domain/money";
import { type Client, type Tx, runInTx, assertTransition, nextNumber } from "@/server/services/_workflow";

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

// ============================================================
// Inventory Transfer (outlet -> outlet)
// ============================================================

const transferSchema = z.object({
  fromOutletId: z.string(),
  toOutletId: z.string(),
  number: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({ materialId: z.string(), requestedQty: z.number().positive(), unitId: z.string().optional() })).min(1),
});

export function createTransfer(ctx: AccessContext, input: z.input<typeof transferSchema>, db: Client = prisma) {
  const data = transferSchema.parse(input);
  if (data.fromOutletId === data.toOutletId) throw new ValidationError("Cannot transfer to the same outlet");
  assertOutletAccess(ctx, data.fromOutletId);
  assertOutletAccess(ctx, data.toOutletId);
  assertCan(ctx, "inventory.transfer", data.fromOutletId);
  return runInTx(db, async (tx) => {
    const number = data.number ?? (await nextNumber(tx, tx.inventoryTransfer, { organizationId: ctx.organizationId }, "TRF"));
    const transfer = await tx.inventoryTransfer.create({
      data: {
        organizationId: ctx.organizationId, number, fromOutletId: data.fromOutletId, toOutletId: data.toOutletId, status: "DRAFT", notes: data.notes, createdById: actor(ctx),
        lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, requestedQty: l.requestedQty, unitId: l.unitId })) },
      },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "InventoryTransfer", entityId: transfer.id, outletId: data.fromOutletId });
    return transfer;
  });
}

export function dispatchTransfer(ctx: AccessContext, transferId: string, overrides?: Array<{ lineId: string; dispatchedQty: number }>, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const transfer = await tx.inventoryTransfer.findUnique({ where: { id: transferId }, include: { lines: true } });
    if (!transfer || transfer.organizationId !== ctx.organizationId) throw new NotFoundError("Transfer not found");
    assertOutletAccess(ctx, transfer.fromOutletId);
    assertCan(ctx, "inventory.transfer", transfer.fromOutletId);
    assertTransition(TRANSFER_TRANSITIONS, transfer.status as TransferStatus, "DISPATCHED", "transfer");
    const overrideMap = new Map((overrides ?? []).map((o) => [o.lineId, o.dispatchedQty]));
    for (const line of transfer.lines) {
      const qty = overrideMap.get(line.id) ?? Number(line.requestedQty);
      if (qty <= 0) continue;
      const rate = await getAvgCost(tx, ctx, transfer.fromOutletId, line.materialId);
      await appendLedger(tx, ctx, {
        outletId: transfer.fromOutletId, materialId: line.materialId, unitId: line.unitId ?? undefined, magnitude: qty, rate,
        txnType: "TRANSFER_OUT", sourceType: "TRANSFER", sourceId: transfer.id, sourceRef: `transfer:${transfer.id}:out:${line.materialId}`,
      });
      await tx.inventoryTransferLine.update({ where: { id: line.id }, data: { dispatchedQty: qty } });
    }
    const updated = await tx.inventoryTransfer.update({ where: { id: transferId }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "InventoryTransfer", entityId: transferId, outletId: transfer.fromOutletId, after: { status: "DISPATCHED" } });
    return updated;
  });
}

export function receiveTransfer(ctx: AccessContext, transferId: string, overrides?: Array<{ lineId: string; receivedQty: number; damagedQty?: number }>, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const transfer = await tx.inventoryTransfer.findUnique({ where: { id: transferId }, include: { lines: true } });
    if (!transfer || transfer.organizationId !== ctx.organizationId) throw new NotFoundError("Transfer not found");
    assertOutletAccess(ctx, transfer.toOutletId);
    assertCan(ctx, "inventory.transfer", transfer.toOutletId);
    assertTransition(TRANSFER_TRANSITIONS, transfer.status as TransferStatus, "RECEIVED", "transfer");
    const overrideMap = new Map((overrides ?? []).map((o) => [o.lineId, o]));
    for (const line of transfer.lines) {
      const o = overrideMap.get(line.id);
      const received = o?.receivedQty ?? Number(line.dispatchedQty);
      const damaged = o?.damagedQty ?? 0;
      const good = received - damaged;
      if (good > 0) {
        const rate = await getAvgCost(tx, ctx, transfer.fromOutletId, line.materialId);
        await appendLedger(tx, ctx, {
          outletId: transfer.toOutletId, materialId: line.materialId, unitId: line.unitId ?? undefined, magnitude: good, rate,
          txnType: "TRANSFER_IN", sourceType: "TRANSFER", sourceId: transfer.id, sourceRef: `transfer:${transfer.id}:in:${line.materialId}`,
        });
      }
      await tx.inventoryTransferLine.update({ where: { id: line.id }, data: { receivedQty: received, damagedQty: damaged } });
    }
    const updated = await tx.inventoryTransfer.update({ where: { id: transferId }, data: { status: "RECEIVED", receivedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "InventoryTransfer", entityId: transferId, outletId: transfer.toOutletId, after: { status: "RECEIVED" } });
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
  notes: z.string().optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: z.number().positive(), unitId: z.string().optional() })).min(1),
});

export function createIssue(ctx: AccessContext, input: z.input<typeof issueSchema>, db: Client = prisma) {
  const data = issueSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "inventory.issue", data.outletId);
  return runInTx(db, async (tx) => {
    const number = data.number ?? (await nextNumber(tx, tx.inventoryIssue, { outletId: data.outletId }, "ISS"));
    const issue = await tx.inventoryIssue.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, number, fromDepartmentId: data.fromDepartmentId, toDepartmentId: data.toDepartmentId, status: "DRAFT", notes: data.notes, createdById: actor(ctx),
        lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, unitId: l.unitId })) },
      },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "InventoryIssue", entityId: issue.id, outletId: data.outletId });
    return issue;
  });
}

export function postIssue(ctx: AccessContext, issueId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const issue = await tx.inventoryIssue.findUnique({ where: { id: issueId }, include: { lines: true } });
    if (!issue || issue.organizationId !== ctx.organizationId) throw new NotFoundError("Issue not found");
    assertOutletAccess(ctx, issue.outletId);
    assertCan(ctx, "inventory.issue", issue.outletId);
    if (issue.status === "ISSUED") return issue; // idempotent
    assertTransition(ISSUE_TRANSITIONS, issue.status as IssueStatus, "ISSUED", "issue");
    for (const line of issue.lines) {
      const rate = await getAvgCost(tx, ctx, issue.outletId, line.materialId);
      await appendLedger(tx, ctx, {
        outletId: issue.outletId, materialId: line.materialId, departmentId: issue.fromDepartmentId ?? undefined, unitId: line.unitId ?? undefined, magnitude: Number(line.qty), rate,
        txnType: "ISSUE", sourceType: "ISSUE", sourceId: issue.id, sourceRef: `issue:${issue.id}:${line.materialId}`,
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

export function enterStockCounts(ctx: AccessContext, countId: string, entries: Array<{ materialId: string; physicalQty: number }>, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const count = await tx.stockCount.findUnique({ where: { id: countId }, include: { lines: true } });
    if (!count || count.organizationId !== ctx.organizationId) throw new NotFoundError("Stock count not found");
    assertOutletAccess(ctx, count.outletId);
    assertCan(ctx, "inventory.count", count.outletId);
    if (count.status !== "COUNTING") throw new ValidationError("Stock count is not in COUNTING state");
    for (const e of entries) {
      const line = count.lines.find((l) => l.materialId === e.materialId);
      if (!line) throw new ValidationError(`Material ${e.materialId} not part of this count`);
      const variance = D(e.physicalQty).minus(D(line.bookQty));
      const avg = await getAvgCost(tx, ctx, count.outletId, e.materialId);
      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { physicalQty: e.physicalQty, variance: variance.toString(), costImpact: money(dMul(variance, avg)).toString() },
      });
    }
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
