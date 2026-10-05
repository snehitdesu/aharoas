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
import { Prisma, type PrismaClient } from "@prisma/client";
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
import { type AccessContext, assertOutletAccess, ConflictError, ValidationError, NotFoundError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { appendLedger, resolveUnit, toBaseUnits } from "@/server/services/inventory";
import { idempotentCreate, requestHashOf } from "@/server/services/idempotency";
import { authorizedOutletIds } from "@/server/services/analytics";
import { D, dMul, dDiv, money, moneyAmount, num, qty as roundQty, type Decimalish } from "@/domain/money";
import { type Client, type Tx, runInTx, assertTransition, nextNumber } from "@/server/services/_workflow";

// ============================================================
// Purchase Indent
// ============================================================

const qtyNum = z.number().positive().max(1_000_000_000);
const rateNum = z.number().nonnegative().max(100_000_000);

const indentSchema = z.object({
  outletId: z.string(),
  number: z.string().optional(),
  departmentId: z.string().optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: qtyNum, unitId: z.string().optional() })).min(1).max(200),
});

/** Every line's material belongs to the org and its unit converts to the base unit. */
async function validateLines(tx: Tx, ctx: AccessContext, lines: Array<{ materialId: string; unitId?: string | null }>) {
  for (const l of lines) await resolveUnit(tx, ctx, l.materialId, l.unitId);
}

export async function createIndent(ctx: AccessContext, input: z.input<typeof indentSchema>, db: Client = prisma) {
  const data = indentSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "purchase.create", data.outletId);
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId);
    await validateLines(tx, ctx, data.lines);
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
  /** An APPROVED indent this PO fulfils (same outlet); raising the PO closes it. */
  indentId: z.string().optional(),
  number: z.string().optional(),
  expectedDate: z.coerce.date().optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: qtyNum, rate: rateNum, taxPct: z.number().min(0).max(100).default(0), unitId: z.string().optional() })).min(1).max(200),
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

export async function createPurchaseOrder(ctx: AccessContext, input: z.input<typeof poSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = poSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "purchase.create", data.outletId);
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "purchase-order", data),
    findPrior: (key) => prisma.purchaseOrder.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      await assertOutletInOrg(tx, ctx, data.outletId);
      await ensureVendor(tx, ctx, data.vendorId);
      await validateLines(tx, ctx, data.lines);
      if (data.indentId) {
        const indent = await tx.purchaseIndent.findUnique({ where: { id: data.indentId } });
        if (!indent || indent.organizationId !== ctx.organizationId) throw new NotFoundError("Indent not found");
        if (indent.outletId !== data.outletId) throw new ValidationError("The indent belongs to a different outlet");
        if (indent.status !== "APPROVED") throw new ValidationError(`Only an APPROVED indent can be ordered (it is ${indent.status})`);
      }
      const number = data.number ?? (await nextNumber(tx, tx.purchaseOrder, { outletId: data.outletId }, "PO"));
      const totals = poTotals(data.lines.map((l) => ({ qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0 })));
      const po = await tx.purchaseOrder.create({
        data: {
          organizationId: ctx.organizationId, outletId: data.outletId, number, vendorId: data.vendorId, status: "DRAFT", indentId: data.indentId, idempotencyKey: key, requestHash: hash,
          expectedDate: data.expectedDate, notes: data.notes, subtotal: totals.subtotal, tax: totals.tax, total: totals.total, createdById: actor(ctx),
          lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0, unitId: l.unitId })) },
        },
      });
      if (data.indentId) {
        await tx.purchaseIndent.update({ where: { id: data.indentId }, data: { status: "CLOSED" } });
        await writeAudit(tx, ctx, { action: "UPDATE", entityType: "PurchaseIndent", entityId: data.indentId, outletId: data.outletId, before: { status: "APPROVED" }, after: { status: "CLOSED", purchaseOrderId: po.id } });
      }
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "PurchaseOrder", entityId: po.id, outletId: data.outletId, after: { indentId: data.indentId } });
      return po;
    }),
  });
}

/**
 * States a person may move a PO to. PARTIAL / RECEIVED are set only by posting
 * GRNs and BILLED only by billing — never by hand.
 */
const MANUAL_PO_TARGETS: ReadonlySet<PurchaseOrderStatus> = new Set(["SUBMITTED", "APPROVED", "ORDERED", "CLOSED", "CANCELLED"]);

/** Manual PO transitions (submit / approve / order / close / cancel). Receiving and billing states are derived. */
export function transitionPurchaseOrder(ctx: AccessContext, poId: string, to: PurchaseOrderStatus, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } });
    if (!po || po.organizationId !== ctx.organizationId) throw new NotFoundError("PO not found");
    assertOutletAccess(ctx, po.outletId);
    assertCan(ctx, to === "APPROVED" ? "purchase.approve" : "purchase.create", po.outletId);
    if (!MANUAL_PO_TARGETS.has(to)) throw new ValidationError(`A purchase order becomes ${to} by receiving or billing goods, not by hand`);
    assertTransition(PURCHASE_ORDER_TRANSITIONS, po.status as PurchaseOrderStatus, to, "purchase order");
    if (to === "CANCELLED") {
      if (po.lines.some((l) => D(l.receivedQty).gt(0))) throw new ValidationError("Goods were received against this PO; close it instead of cancelling");
      const posted = await tx.goodsReceipt.count({ where: { poId, status: "POSTED" } });
      if (posted > 0) throw new ValidationError("A posted GRN exists for this PO; close it instead of cancelling");
    }
    const updated = await tx.purchaseOrder.update({
      where: { id: poId },
      data: { status: to, approvedById: to === "APPROVED" ? actor(ctx) : undefined, approvedAt: to === "APPROVED" ? new Date() : undefined },
    });
    await writeAudit(tx, ctx, { action: to === "APPROVED" ? "APPROVE" : to === "CANCELLED" ? "VOID" : "UPDATE", entityType: "PurchaseOrder", entityId: poId, outletId: po.outletId, before: { status: po.status }, after: { status: to } });
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
  notes: z.string().max(1000).optional(),
  lines: z.array(z.object({
    materialId: z.string(), qty: qtyNum, rate: rateNum,
    /** Rejected at the door (damaged / not acceptable): never enters stock, never billable. */
    damagedQty: z.number().nonnegative().max(1_000_000_000).default(0), batchNo: z.string().max(100).optional(), expiryDate: z.coerce.date().optional(), unitId: z.string().optional(),
  })).min(1).max(200),
});

/** POs goods can be received against. */
const RECEIVABLE_PO: ReadonlySet<string> = new Set(["APPROVED", "ORDERED", "PARTIAL"]);

/**
 * Accepted (good) base quantity per material still open on a PO:
 * Σ over its lines of (ordered − received) × line unit factor.
 */
async function poOutstandingBase(tx: Tx, ctx: AccessContext, po: { lines: Array<{ materialId: string; qty: Decimalish; receivedQty: Decimalish; unitId: string | null }> }) {
  const open = new Map<string, Prisma.Decimal>();
  for (const l of po.lines) {
    const { factor } = await resolveUnit(tx, ctx, l.materialId, l.unitId);
    const rest = D(l.qty).minus(D(l.receivedQty));
    open.set(l.materialId, (open.get(l.materialId) ?? D(0)).plus(rest.gt(0) ? rest.times(factor) : D(0)));
  }
  return open;
}

/** Accepted (good) base quantity per material on a GRN, plus each line converted. */
async function grnGoodBase(tx: Tx, ctx: AccessContext, lines: Array<{ id?: string; materialId: string; qty: Decimalish; damagedQty: Decimalish; rate: Decimalish; unitId?: string | null }>) {
  const byMaterial = new Map<string, Prisma.Decimal>();
  const converted = [];
  for (const l of lines) {
    const good = D(l.qty).minus(D(l.damagedQty));
    const base = await toBaseUnits(tx, ctx, l.materialId, good, l.unitId, l.rate);
    converted.push({ line: l, good, base });
    if (good.gt(0)) byMaterial.set(l.materialId, (byMaterial.get(l.materialId) ?? D(0)).plus(base.qty));
  }
  return { byMaterial, converted };
}

/** The PO checks shared by GRN creation and posting. */
async function assertReceivableAgainstPo(tx: Tx, ctx: AccessContext, poId: string, grn: { outletId: string; vendorId: string }, goodByMaterial: Map<string, Prisma.Decimal>) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } });
  if (!po || po.organizationId !== ctx.organizationId || po.outletId !== grn.outletId) throw new ValidationError("PO not valid for this outlet");
  if (po.vendorId !== grn.vendorId) throw new ValidationError("The GRN vendor does not match the purchase order's vendor");
  if (!RECEIVABLE_PO.has(po.status)) throw new ValidationError(`Goods cannot be received against a ${po.status} purchase order`);
  const open = await poOutstandingBase(tx, ctx, po);
  for (const [materialId, good] of goodByMaterial) {
    if (!po.lines.some((l) => l.materialId === materialId)) throw new ValidationError(`Material ${materialId} is not on purchase order ${po.number}`);
    const left = open.get(materialId) ?? D(0);
    if (good.gt(left)) throw new ValidationError(`Receiving ${roundQty(good).toString()} of material ${materialId} exceeds the ${roundQty(left).toString()} still open on ${po.number} (base units)`);
  }
  return po;
}

export async function createGRN(ctx: AccessContext, input: z.input<typeof grnSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = grnSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "grn.create", data.outletId);
  for (const l of data.lines) if ((l.damagedQty ?? 0) > l.qty) throw new ValidationError(`Rejected/damaged quantity cannot exceed the delivered quantity (material ${l.materialId})`);
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "grn", data),
    findPrior: (key) => prisma.goodsReceipt.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      await assertOutletInOrg(tx, ctx, data.outletId);
      await ensureVendor(tx, ctx, data.vendorId);
      const { byMaterial } = await grnGoodBase(tx, ctx, data.lines.map((l) => ({ ...l, damagedQty: l.damagedQty ?? 0 }))); // validates materials + units
      if (data.poId) await assertReceivableAgainstPo(tx, ctx, data.poId, data, byMaterial);
      const number = data.number ?? (await nextNumber(tx, tx.goodsReceipt, { outletId: data.outletId }, "GRN"));
      const grn = await tx.goodsReceipt.create({
        data: {
          organizationId: ctx.organizationId, outletId: data.outletId, number, poId: data.poId, vendorId: data.vendorId, status: "DRAFT", notes: data.notes, createdById: actor(ctx), idempotencyKey: key, requestHash: hash,
          lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, rate: l.rate, damagedQty: l.damagedQty ?? 0, batchNo: l.batchNo, expiryDate: l.expiryDate, unitId: l.unitId })) },
        },
      });
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "GoodsReceipt", entityId: grn.id, outletId: data.outletId });
      return grn;
    }),
  });
}

/**
 * Post a GRN: DRAFT -> POSTED. Each line's accepted quantity (delivered −
 * rejected) is converted to the material's base unit and written as a
 * PURCHASE_RECEIPT row at the base-unit rate (rate ÷ factor), so the value and
 * the weighted-average cost are exact. The PO is re-validated here (status,
 * vendor, open quantity) because other GRNs may have been posted since this
 * one was drafted; its received quantities and PARTIAL/RECEIVED status follow.
 * Idempotent: a posted GRN is returned as is; each line's ledger sourceRef
 * `grn:<grn>:<line>` is unique (several lines/batches of one material are fine).
 */
export function postGRN(ctx: AccessContext, grnId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const grn = await tx.goodsReceipt.findUnique({ where: { id: grnId }, include: { lines: true } });
    if (!grn || grn.organizationId !== ctx.organizationId) throw new NotFoundError("GRN not found");
    assertOutletAccess(ctx, grn.outletId);
    assertCan(ctx, "grn.create", grn.outletId);
    if (grn.status === "POSTED") return grn; // idempotent no-op
    assertTransition(GRN_TRANSITIONS, grn.status as GRNStatus, "POSTED", "GRN");

    const { byMaterial, converted } = await grnGoodBase(tx, ctx, grn.lines);
    if (grn.poId) await assertReceivableAgainstPo(tx, ctx, grn.poId, grn, byMaterial);

    for (const { line, good, base } of converted) {
      if (good.lte(0)) continue; // fully rejected line: nothing enters stock
      await appendLedger(tx, ctx, {
        outletId: grn.outletId, materialId: line.materialId, unitId: base.baseUnitId, magnitude: base.qty, rate: base.rate,
        batchNo: (line as { batchNo?: string | null }).batchNo ?? undefined, expiryDate: (line as { expiryDate?: Date | null }).expiryDate ?? undefined,
        txnType: "PURCHASE_RECEIPT", sourceType: "GRN", sourceId: grn.id, sourceRef: `grn:${grn.id}:${line.id}`, note: `GRN ${grn.number}`,
      });
    }

    if (grn.poId) await updatePoOnReceipt(tx, ctx, grn.poId, byMaterial);

    const updated = await tx.goodsReceipt.update({ where: { id: grnId }, data: { status: "POSTED", postedAt: new Date() } });
    await writeAudit(tx, ctx, {
      action: "INVENTORY_MOVEMENT", entityType: "GoodsReceipt", entityId: grnId, outletId: grn.outletId,
      after: { status: "POSTED", lines: converted.map((c) => ({ materialId: c.line.materialId, accepted: c.good.toString(), rejected: D(c.line.damagedQty).toString(), baseQty: c.base.qty.toString() })) },
    });
    return updated;
  });
}

/**
 * Add the accepted base quantities to the PO's lines (filling each line of a
 * material in order, converted to that line's unit) and derive its status.
 */
async function updatePoOnReceipt(tx: Tx, ctx: AccessContext, poId: string, received: Map<string, Prisma.Decimal>) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: { orderBy: { id: "asc" } } } });
  if (!po || po.organizationId !== ctx.organizationId) return;
  for (const [materialId, goodBase] of received) {
    let left = goodBase;
    for (const line of po.lines.filter((l) => l.materialId === materialId)) {
      if (left.lte(0)) break;
      const { factor } = await resolveUnit(tx, ctx, line.materialId, line.unitId);
      const openBase = D(line.qty).minus(D(line.receivedQty)).times(factor);
      if (openBase.lte(0)) continue;
      const take = Prisma.Decimal.min(left, openBase);
      await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQty: roundQty(D(line.receivedQty).plus(take.div(factor))) } });
      left = left.minus(take);
    }
  }
  const fresh = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true } });
  const allReceived = fresh.lines.every((l) => D(l.receivedQty).gte(D(l.qty)));
  const anyReceived = fresh.lines.some((l) => D(l.receivedQty).gt(0));
  const next = allReceived ? "RECEIVED" : anyReceived ? "PARTIAL" : fresh.status;
  if (next !== fresh.status) {
    await tx.purchaseOrder.update({ where: { id: poId }, data: { status: next } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "PurchaseOrder", entityId: poId, outletId: fresh.outletId, before: { status: fresh.status }, after: { status: next, via: "goods receipt" } });
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
  /** The vendor's invoice number: one bill per (vendor, invoice number). */
  vendorInvoiceNo: z.string().trim().min(1).max(64).optional(),
  dueDate: z.coerce.date().optional(),
  /** Against a GRN, a line's qty is in the unit the goods were received in. */
  lines: z.array(z.object({ materialId: z.string(), qty: qtyNum, rate: rateNum, taxPct: z.number().min(0).max(100).default(0) })).min(1).max(200),
});

/**
 * Three-way match against the GRN: only materials on the GRN, and for each
 * material at most the accepted quantity not yet on another live bill of this
 * GRN (so the same received quantity is never billed twice).
 */
async function assertBillableAgainstGrn(tx: Tx, ctx: AccessContext, grnId: string, bill: { outletId: string; vendorId: string; lines: Array<{ materialId: string; qty: number }> }) {
  const grn = await tx.goodsReceipt.findUnique({ where: { id: grnId }, include: { lines: true } });
  if (!grn || grn.organizationId !== ctx.organizationId) throw new NotFoundError("GRN not found");
  if (grn.outletId !== bill.outletId || grn.vendorId !== bill.vendorId) throw new ValidationError("GRN belongs to a different outlet or vendor");
  if (grn.status !== "POSTED") throw new ValidationError("Only a posted GRN can be billed");
  const accepted = new Map<string, Prisma.Decimal>();
  const units = new Map<string, Set<string>>();
  for (const l of grn.lines) {
    accepted.set(l.materialId, (accepted.get(l.materialId) ?? D(0)).plus(D(l.qty).minus(D(l.damagedQty))));
    units.set(l.materialId, (units.get(l.materialId) ?? new Set()).add(l.unitId ?? ""));
  }
  const billed = await tx.purchaseBillLine.findMany({ where: { bill: { grnId, status: { not: "CANCELLED" } } }, select: { materialId: true, qty: true } });
  const already = new Map<string, Prisma.Decimal>();
  for (const b of billed) already.set(b.materialId, (already.get(b.materialId) ?? D(0)).plus(D(b.qty)));
  const asked = new Map<string, Prisma.Decimal>();
  for (const l of bill.lines) asked.set(l.materialId, (asked.get(l.materialId) ?? D(0)).plus(D(l.qty)));
  for (const [materialId, qty] of asked) {
    if (!accepted.has(materialId)) throw new ValidationError(`Material ${materialId} was not received on GRN ${grn.number}`);
    if ((units.get(materialId)?.size ?? 0) > 1) throw new ValidationError(`Material ${materialId} was received in several units on GRN ${grn.number}; bill it from separate GRNs`);
    const open = accepted.get(materialId)!.minus(already.get(materialId) ?? D(0));
    if (qty.gt(open)) throw new ValidationError(`Billing ${qty.toString()} of material ${materialId} exceeds the ${open.lt(0) ? "0" : open.toString()} received and not yet billed on GRN ${grn.number}`);
  }
  return grn;
}

export async function createPurchaseBill(ctx: AccessContext, input: z.input<typeof billSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = billSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "bill.manage", data.outletId);
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "purchase-bill", data),
    findPrior: (key) => prisma.purchaseBill.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      await assertOutletInOrg(tx, ctx, data.outletId);
      await ensureVendor(tx, ctx, data.vendorId);
      await validateLines(tx, ctx, data.lines);
      if (data.vendorInvoiceNo) {
        const dup = await tx.purchaseBill.findUnique({ where: { organizationId_vendorId_vendorInvoiceNo: { organizationId: ctx.organizationId, vendorId: data.vendorId, vendorInvoiceNo: data.vendorInvoiceNo } } });
        if (dup) throw new ConflictError(`Vendor invoice ${data.vendorInvoiceNo} is already recorded as bill ${dup.number}`);
      }
      const grn = data.grnId ? await assertBillableAgainstGrn(tx, ctx, data.grnId, data) : null;
      const number = data.number ?? (await nextNumber(tx, tx.purchaseBill, { outletId: data.outletId }, "BILL"));
      const totals = poTotals(data.lines.map((l) => ({ qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0 })));
      const bill = await tx.purchaseBill.create({
        data: {
          organizationId: ctx.organizationId, outletId: data.outletId, number, vendorId: data.vendorId, grnId: data.grnId, vendorInvoiceNo: data.vendorInvoiceNo, idempotencyKey: key, requestHash: hash,
          dueDate: data.dueDate, subtotal: totals.subtotal, tax: totals.tax, total: totals.total, paidAmount: 0, status: "OPEN", createdById: actor(ctx),
          lines: { create: data.lines.map((l) => ({ organizationId: ctx.organizationId, materialId: l.materialId, qty: l.qty, rate: l.rate, taxPct: l.taxPct ?? 0 })) },
        },
      });
      // Billing state of the PO is derived: BILLED once received in full and billed.
      if (grn?.poId) {
        const po = await tx.purchaseOrder.findUnique({ where: { id: grn.poId } });
        if (po && po.status === "RECEIVED") {
          await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: "BILLED" } });
          await writeAudit(tx, ctx, { action: "UPDATE", entityType: "PurchaseOrder", entityId: po.id, outletId: po.outletId, before: { status: "RECEIVED" }, after: { status: "BILLED", via: "purchase bill" } });
        }
      }
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "PurchaseBill", entityId: bill.id, outletId: data.outletId, after: { total: totals.total.toString(), grnId: data.grnId, vendorInvoiceNo: data.vendorInvoiceNo } });
      return bill;
    }),
  }).catch((e) => {
    // Two clerks entering the same vendor invoice at once: the unique index decides.
    if ((e as { code?: string })?.code === "P2002" && data.vendorInvoiceNo) throw new ConflictError(`Vendor invoice ${data.vendorInvoiceNo} is already recorded`);
    throw e;
  });
}

export function cancelPurchaseBill(ctx: AccessContext, billId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const bill = await tx.purchaseBill.findUnique({ where: { id: billId }, include: { payments: true } });
    if (!bill || bill.organizationId !== ctx.organizationId) throw new NotFoundError("Bill not found");
    assertOutletAccess(ctx, bill.outletId);
    assertCan(ctx, "bill.manage", bill.outletId);
    assertTransition(PURCHASE_BILL_TRANSITIONS, bill.status as PurchaseBillStatus, "CANCELLED", "bill");
    if (bill.payments.some((p) => !p.reversedAt)) throw new ValidationError("Cannot cancel a bill that has payments (reverse them first)");
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
  amount: moneyAmount(z.number().positive()),
  method: VendorPaymentMethod.zod.default("BANK"),
  reference: z.string().optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export async function payVendor(ctx: AccessContext, input: z.input<typeof vendorPaySchema>, db: Client = prisma) {
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
      // A further partial payment leaves a PARTIAL bill PARTIAL (not a transition).
      if (billStatus !== bill.status) assertTransition(PURCHASE_BILL_TRANSITIONS, bill.status as PurchaseBillStatus, billStatus, "bill");
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
