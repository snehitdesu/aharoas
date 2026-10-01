/**
 * Procurement workflow services (procure-to-pay).
 *
 * Purchase Indent -> Purchase Order -> Goods Receipt (posts ledger)
 *   -> Purchase Bill -> Vendor Payment.
 *
 * Every transition validates: current state, actor permission, outlet/org scope,
 * legal transition, and runs side effects transactionally with an audit row.
 * Posting a GRN is idempotent (state guard + unique ledger sourceRef).
 */
import { type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  INDENT_TRANSITIONS,
  PURCHASE_ORDER_TRANSITIONS,
  GRN_TRANSITIONS,
  PURCHASE_BILL_TRANSITIONS,
  VendorPaymentMethod,
  type IndentStatus,
  type PurchaseOrderStatus,
  type GRNStatus,
  type PurchaseBillStatus,
} from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { recordPurchaseReceipt } from "@/server/services/inventory";
import { authorizedOutletIds } from "@/server/services/analytics";
import { D, dMul, dDiv, money, num } from "@/domain/money";
import { type Client, type Tx, runInTx, assertTransition, nextNumber } from "@/server/services/_workflow";

// ============================================================
// Purchase Indent
// ============================================================

const indentSchema = z.object({
  outletId: z.string(),
  number: z.string().optional(),
  departmentId: z.string().optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: z.number().positive(), unitId: z.string().optional() })).min(1),
});

export function createIndent(ctx: AccessContext, input: z.input<typeof indentSchema>, db: Client = prisma) {
  const data = indentSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "purchase.create", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    const number = data.number ?? (await nextNumber(tx, tx.purchaseIndent, { outletId: data.outletId }, "IND"));
    const indent = await tx.purchaseIndent.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, number, departmentId: data.departmentId, status: "DRAFT",
        createdById: actor(ctx),
        lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, unitId: l.unitId })) },
      },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "PurchaseIndent", entityId: indent.id, outletId: data.outletId });
    return indent;
  });
}

export function transitionIndent(ctx: AccessContext, indentId: string, to: IndentStatus, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const indent = await tx.purchaseIndent.findUnique({ where: { id: indentId } });
    if (!indent || indent.organizationId !== ctx.organizationId) throw new NotFoundError("Indent not found");
    assertOutletAccess(ctx, indent.outletId);
    assertCan(ctx, to === "APPROVED" ? "purchase.approve" : "purchase.create", indent.outletId);
    assertTransition(INDENT_TRANSITIONS, indent.status as IndentStatus, to, "indent");
    const updated = await tx.purchaseIndent.update({
      where: { id: indentId },
      data: { status: to, approvedById: to === "APPROVED" ? actor(ctx) : undefined },
    });
    await writeAudit(tx, ctx, { action: to === "APPROVED" ? "APPROVE" : "UPDATE", entityType: "PurchaseIndent", entityId: indentId, outletId: indent.outletId, before: { status: indent.status }, after: { status: to } });
    return updated;
  });
}

// ============================================================
// Purchase Order
// ============================================================

const poSchema = z.object({
  outletId: z.string(),
  vendorId: z.string(),
  number: z.string().optional(),
  expectedDate: z.coerce.date().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: z.number().positive(), rate: z.number().nonnegative(), taxPct: z.number().nonnegative().default(0), unitId: z.string().optional() })).min(1),
});

function poTotals(lines: Array<{ qty: number; rate: number; taxPct: number }>) {
  let subtotal = D(0), tax = D(0);
  for (const l of lines) {
    const net = dMul(l.qty, l.rate);
    subtotal = subtotal.plus(net);
    tax = tax.plus(dMul(net, dDiv(l.taxPct, 100)));
  }
  return { subtotal: money(subtotal), tax: money(tax), total: money(subtotal.plus(tax)) };
}

export function createPurchaseOrder(ctx: AccessContext, input: z.input<typeof poSchema>, db: Client = prisma) {
  const data = poSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "purchase.create", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    await ensureVendor(tx, ctx, data.vendorId);
    const number = data.number ?? (await nextNumber(tx, tx.purchaseOrder, { outletId: data.outletId }, "PO"));
    const totals = poTotals(data.lines.map((l) => ({ qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0 })));
    const po = await tx.purchaseOrder.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, number, vendorId: data.vendorId, status: "DRAFT",
        expectedDate: data.expectedDate, notes: data.notes, subtotal: totals.subtotal, tax: totals.tax, total: totals.total, createdById: actor(ctx),
        lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0, unitId: l.unitId })) },
      },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "PurchaseOrder", entityId: po.id, outletId: data.outletId });
    return po;
  });
}

/** Generic PO transition for the non-receipt states (submit/approve/order/cancel/close). */
export function transitionPurchaseOrder(ctx: AccessContext, poId: string, to: PurchaseOrderStatus, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po || po.organizationId !== ctx.organizationId) throw new NotFoundError("PO not found");
    assertOutletAccess(ctx, po.outletId);
    assertCan(ctx, to === "APPROVED" ? "purchase.approve" : "purchase.create", po.outletId);
    assertTransition(PURCHASE_ORDER_TRANSITIONS, po.status as PurchaseOrderStatus, to, "purchase order");
    const updated = await tx.purchaseOrder.update({
      where: { id: poId },
      data: { status: to, approvedById: to === "APPROVED" ? actor(ctx) : undefined, approvedAt: to === "APPROVED" ? new Date() : undefined },
    });
    await writeAudit(tx, ctx, { action: to === "APPROVED" ? "APPROVE" : "UPDATE", entityType: "PurchaseOrder", entityId: poId, outletId: po.outletId, before: { status: po.status }, after: { status: to } });
    return updated;
  });
}

// ============================================================
// Goods Receipt (GRN) — posts the inventory ledger
// ============================================================

const grnSchema = z.object({
  outletId: z.string(),
  vendorId: z.string(),
  poId: z.string().optional(),
  number: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    materialId: z.string(), qty: z.number().positive(), rate: z.number().nonnegative(),
    damagedQty: z.number().nonnegative().default(0), batchNo: z.string().optional(), expiryDate: z.coerce.date().optional(), unitId: z.string().optional(),
  })).min(1),
});

export function createGRN(ctx: AccessContext, input: z.input<typeof grnSchema>, db: Client = prisma) {
  const data = grnSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "grn.create", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    await ensureVendor(tx, ctx, data.vendorId);
    if (data.poId) {
      const po = await tx.purchaseOrder.findUnique({ where: { id: data.poId } });
      if (!po || po.organizationId !== ctx.organizationId || po.outletId !== data.outletId) throw new ValidationError("PO not valid for this outlet");
    }
    const number = data.number ?? (await nextNumber(tx, tx.goodsReceipt, { outletId: data.outletId }, "GRN"));
    const grn = await tx.goodsReceipt.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, number, poId: data.poId, vendorId: data.vendorId, status: "DRAFT", notes: data.notes, createdById: actor(ctx),
        lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, rate: l.rate, damagedQty: l.damagedQty ?? 0, batchNo: l.batchNo, expiryDate: l.expiryDate, unitId: l.unitId })) },
      },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "GoodsReceipt", entityId: grn.id, outletId: data.outletId });
    return grn;
  });
}

/** Post a GRN: DRAFT -> POSTED. Writes PURCHASE_RECEIPT ledger rows and updates the PO. Idempotent. */
export function postGRN(ctx: AccessContext, grnId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const grn = await tx.goodsReceipt.findUnique({ where: { id: grnId }, include: { lines: true } });
    if (!grn || grn.organizationId !== ctx.organizationId) throw new NotFoundError("GRN not found");
    assertOutletAccess(ctx, grn.outletId);
    assertCan(ctx, "grn.create", grn.outletId);
    if (grn.status === "POSTED") return grn; // idempotent no-op
    assertTransition(GRN_TRANSITIONS, grn.status as GRNStatus, "POSTED", "GRN");

    for (const line of grn.lines) {
      const good = D(line.qty).minus(D(line.damagedQty)); // damaged stock does not enter inventory
      if (good.lte(0)) continue;
      await recordPurchaseReceipt(ctx, {
        outletId: grn.outletId, materialId: line.materialId, quantity: good.toString(), rate: Number(line.rate),
        unitId: line.unitId ?? undefined, batchNo: line.batchNo ?? undefined, expiryDate: line.expiryDate ?? undefined,
        sourceId: grn.id, sourceRef: `grn:${grn.id}:${line.materialId}`,
      }, tx);
    }

    // Update linked PO received quantities + status.
    if (grn.poId) await updatePoOnReceipt(tx, ctx, grn.poId, grn.lines.map((l) => ({ materialId: l.materialId, good: Number(D(l.qty).minus(D(l.damagedQty))) })));

    const updated = await tx.goodsReceipt.update({ where: { id: grnId }, data: { status: "POSTED", postedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "GoodsReceipt", entityId: grnId, outletId: grn.outletId, after: { status: "POSTED" } });
    return updated;
  });
}

async function updatePoOnReceipt(tx: Tx, ctx: AccessContext, poId: string, received: Array<{ materialId: string; good: number }>) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } });
  if (!po || po.organizationId !== ctx.organizationId) return;
  for (const r of received) {
    const line = po.lines.find((l) => l.materialId === r.materialId);
    if (line) await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQty: D(line.receivedQty).plus(r.good) } });
  }
  const fresh = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } });
  if (!fresh) return;
  const allReceived = fresh.lines.every((l) => D(l.receivedQty).gte(D(l.qty)));
  const anyReceived = fresh.lines.some((l) => D(l.receivedQty).gt(0));
  // Only advance from active ordering states.
  if (["APPROVED", "ORDERED", "PARTIAL"].includes(fresh.status)) {
    const next = allReceived ? "RECEIVED" : anyReceived ? "PARTIAL" : fresh.status;
    if (next !== fresh.status) await tx.purchaseOrder.update({ where: { id: poId }, data: { status: next } });
  }
}

// ============================================================
// Purchase Bill
// ============================================================

const billSchema = z.object({
  outletId: z.string(),
  vendorId: z.string(),
  grnId: z.string().optional(),
  number: z.string().optional(),
  dueDate: z.coerce.date().optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: z.number().positive(), rate: z.number().nonnegative(), taxPct: z.number().nonnegative().default(0) })).min(1),
});

export function createPurchaseBill(ctx: AccessContext, input: z.input<typeof billSchema>, db: Client = prisma) {
  const data = billSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "bill.manage", data.outletId);
  return runInTx(db, async (tx) => {
    await ensureVendor(tx, ctx, data.vendorId);
    if (data.grnId) {
      const grn = await tx.goodsReceipt.findUnique({ where: { id: data.grnId } });
      if (!grn || grn.organizationId !== ctx.organizationId) throw new NotFoundError("GRN not found");
      if (grn.outletId !== data.outletId || grn.vendorId !== data.vendorId) throw new ValidationError("GRN belongs to a different outlet or vendor");
      if (grn.status !== "POSTED") throw new ValidationError("Only a posted GRN can be billed");
    }
    const number = data.number ?? (await nextNumber(tx, tx.purchaseBill, { outletId: data.outletId }, "BILL"));
    const totals = poTotals(data.lines.map((l) => ({ qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0 })));
    const bill = await tx.purchaseBill.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, number, vendorId: data.vendorId, grnId: data.grnId,
        dueDate: data.dueDate, subtotal: totals.subtotal, tax: totals.tax, total: totals.total, paidAmount: 0, status: "OPEN", createdById: actor(ctx),
        lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0 })) },
      },
    });
    // Mark linked PO as BILLED where legal.
    if (data.grnId) {
      const grn = await tx.goodsReceipt.findUnique({ where: { id: data.grnId } });
      if (grn?.poId) {
        const po = await tx.purchaseOrder.findUnique({ where: { id: grn.poId } });
        if (po && po.status === "RECEIVED") await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: "BILLED" } });
      }
    }
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "PurchaseBill", entityId: bill.id, outletId: data.outletId });
    return bill;
  });
}

export function cancelPurchaseBill(ctx: AccessContext, billId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const bill = await tx.purchaseBill.findUnique({ where: { id: billId }, include: { payments: true } });
    if (!bill || bill.organizationId !== ctx.organizationId) throw new NotFoundError("Bill not found");
    assertOutletAccess(ctx, bill.outletId);
    assertCan(ctx, "bill.manage", bill.outletId);
    assertTransition(PURCHASE_BILL_TRANSITIONS, bill.status as PurchaseBillStatus, "CANCELLED", "bill");
    if (bill.payments.length > 0) throw new ValidationError("Cannot cancel a bill that has payments");
    const updated = await tx.purchaseBill.update({ where: { id: billId }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "PurchaseBill", entityId: billId, outletId: bill.outletId });
    return updated;
  });
}

// ============================================================
// Vendor Payment (reduces the bill's outstanding balance)
// ============================================================

const vendorPaySchema = z.object({
  outletId: z.string(),
  vendorId: z.string(),
  billId: z.string().optional(),
  amount: z.number().positive(),
  method: VendorPaymentMethod.zod.default("BANK"),
  reference: z.string().optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export function payVendor(ctx: AccessContext, input: z.input<typeof vendorPaySchema>, db: Client = prisma) {
  const data = vendorPaySchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "vendor.pay", data.outletId);
  return runInTx(db, async (tx) => {
    await ensureVendor(tx, ctx, data.vendorId);
    // Replay of the same request (retry / double submit) returns the original payment.
    if (data.idempotencyKey) {
      const prior = await tx.vendorPayment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: data.idempotencyKey } } });
      if (prior) {
        if (prior.vendorId !== data.vendorId || prior.billId !== (data.billId ?? null) || !D(prior.amount).eq(D(data.amount))) throw new ValidationError("Idempotency key was already used for a different payment");
        return prior;
      }
    }
    let billStatus: PurchaseBillStatus | undefined;
    if (data.billId) {
      const bill = await tx.purchaseBill.findUnique({ where: { id: data.billId } });
      if (!bill || bill.organizationId !== ctx.organizationId) throw new NotFoundError("Bill not found");
      if (bill.vendorId !== data.vendorId || bill.outletId !== data.outletId) throw new ValidationError("Bill belongs to a different vendor or outlet");
      if (bill.status === "CANCELLED") throw new ValidationError("Cannot pay a cancelled bill");
      const remaining = D(bill.total).minus(D(bill.paidAmount));
      if (D(data.amount).gt(remaining)) throw new ValidationError(`Payment ${data.amount} exceeds outstanding ${remaining.toString()}`);
      const newPaid = D(bill.paidAmount).plus(data.amount);
      billStatus = newPaid.gte(D(bill.total)) ? "PAID" : "PARTIAL";
      assertTransition(PURCHASE_BILL_TRANSITIONS, bill.status as PurchaseBillStatus, billStatus, "bill");
      await tx.purchaseBill.update({ where: { id: data.billId }, data: { paidAmount: money(newPaid), status: billStatus } });
    }
    const payment = await tx.vendorPayment.create({
      data: { organizationId: ctx.organizationId, outletId: data.outletId, vendorId: data.vendorId, billId: data.billId, amount: money(data.amount), method: data.method, reference: data.reference, idempotencyKey: data.idempotencyKey, actorId: actor(ctx) },
    });
    await writeAudit(tx, ctx, { action: "PAYMENT", entityType: "VendorPayment", entityId: payment.id, outletId: data.outletId, after: { amount: data.amount, billStatus } });
    return payment;
  });
}

// ============================================================
// helpers
// ============================================================

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

async function ensureVendor(tx: Tx, ctx: AccessContext, vendorId: string) {
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor || vendor.organizationId !== ctx.organizationId) throw new ValidationError("Vendor not found in organization");
}

export type VendorDueRow = { vendorId: string; vendorName: string; openBills: number; billed: number; paid: number; due: number; overdue: number };

/**
 * Outstanding dues per vendor (open/partial bills: total - paid), aggregated in
 * the DB and restricted to outlets the caller can see. `overdue` is the part of
 * `due` on bills whose dueDate is before `asOf` (default now).
 */
export async function vendorDues(
  db: PrismaClient,
  ctx: AccessContext,
  filter: { vendorId?: string; outletId?: string; asOf?: Date } = {}
): Promise<VendorDueRow[]> {
  // Only outlets where the actor actually holds finance.view (explicit outlet: 403 if not).
  const outletIds = authorizedOutletIds(ctx, { outletId: filter.outletId }, "finance.view");
  if (!outletIds.length) return [];
  const where = {
    organizationId: ctx.organizationId,
    outletId: { in: outletIds },
    status: { in: ["OPEN", "PARTIAL"] },
    ...(filter.vendorId ? { vendorId: filter.vendorId } : {}),
  };
  const [all, overdue] = await Promise.all([
    db.purchaseBill.groupBy({ by: ["vendorId"], where, _sum: { total: true, paidAmount: true }, _count: true }),
    db.purchaseBill.groupBy({ by: ["vendorId"], where: { ...where, dueDate: { lt: filter.asOf ?? new Date() } }, _sum: { total: true, paidAmount: true } }),
  ]);
  const overdueMap = new Map(overdue.map((o) => [o.vendorId, D(o._sum.total ?? 0).minus(D(o._sum.paidAmount ?? 0))]));
  const vendors = await db.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: all.map((a) => a.vendorId) } }, select: { id: true, name: true } });
  const names = new Map(vendors.map((v) => [v.id, v.name]));
  return all
    .map((a) => {
      const billed = D(a._sum.total ?? 0);
      const paid = D(a._sum.paidAmount ?? 0);
      return {
        vendorId: a.vendorId,
        vendorName: names.get(a.vendorId) ?? a.vendorId,
        openBills: a._count,
        billed: num(money(billed)),
        paid: num(money(paid)),
        due: num(money(billed.minus(paid))),
        overdue: num(money(overdueMap.get(a.vendorId) ?? D(0))),
      };
    })
    .sort((x, y) => y.due - x.due);
}
