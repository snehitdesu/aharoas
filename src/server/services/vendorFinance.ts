/**
 * Vendor payables beyond what procurement.ts already does (bills, payments,
 * overpayment guard, payment idempotency):
 *
 *  - aging: open bill balances bucketed by days past due (no due date: past
 *    the bill date), plus unapplied advances (payments not allocated to a
 *    bill) per vendor, and the net payable;
 *  - statement: one vendor's bills, payments and reversals in date order with
 *    a running balance;
 *  - reversal: a bounced cheque / returned transfer reverses a payment — the
 *    row is kept (marked reversed) and stops counting against its bill, whose
 *    balance and status follow (PAID -> PARTIAL / OPEN).
 *
 * Money stays Decimal end to end; amounts are reported rounded to the paisa.
 * Reversed payments never count as paid anywhere (dues, statement, cancel rule,
 * vendor reconciliation).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { PURCHASE_BILL_TRANSITIONS, type PurchaseBillStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, runInTx, assertTransition } from "@/server/services/_workflow";
import { authorizedOutletIds } from "@/server/services/analytics";
import { D, money, num } from "@/domain/money";

const DAY = 86_400_000;
export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export type VendorAgingRow = { vendorId: string; vendorName: string; openBills: number } & Record<AgingBucket, number> & { totalDue: number; advances: number; netPayable: number };

function bucketOf(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90_plus";
}

/** Payables aging as of `asOf` (default now), per vendor, for outlets where the actor holds finance.view. */
export async function vendorAging(db: PrismaClient, ctx: AccessContext, filter: { outletId?: string; vendorId?: string; asOf?: Date } = {}): Promise<VendorAgingRow[]> {
  const ids = authorizedOutletIds(ctx, { outletId: filter.outletId }, "finance.view");
  if (!ids.length) return [];
  const asOf = filter.asOf ?? new Date();
  const [bills, advances] = await Promise.all([
    db.purchaseBill.findMany({
      where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: { in: ["OPEN", "PARTIAL"] }, billDate: { lte: asOf }, ...(filter.vendorId ? { vendorId: filter.vendorId } : {}) },
      select: { vendorId: true, total: true, paidAmount: true, dueDate: true, billDate: true },
    }),
    db.vendorPayment.groupBy({
      by: ["vendorId"],
      where: { organizationId: ctx.organizationId, outletId: { in: ids }, billId: null, reversedAt: null, paidAt: { lte: asOf }, ...(filter.vendorId ? { vendorId: filter.vendorId } : {}) },
      _sum: { amount: true },
    }),
  ]);
  const rows = new Map<string, { openBills: number; buckets: Record<AgingBucket, ReturnType<typeof D>> }>();
  for (const b of bills) {
    const due = D(b.total).minus(D(b.paidAmount));
    if (due.lte(0)) continue;
    const ref = b.dueDate ?? b.billDate;
    const bucket = bucketOf(Math.floor((asOf.getTime() - ref.getTime()) / DAY));
    const r = rows.get(b.vendorId) ?? { openBills: 0, buckets: Object.fromEntries(AGING_BUCKETS.map((k) => [k, D(0)])) as Record<AgingBucket, ReturnType<typeof D>> };
    r.openBills++;
    r.buckets[bucket] = r.buckets[bucket].plus(due);
    rows.set(b.vendorId, r);
  }
  const adv = new Map(advances.map((a) => [a.vendorId, D(a._sum.amount ?? 0)]));
  const vendorIds = [...new Set([...rows.keys(), ...adv.keys()])];
  const vendors = await db.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: vendorIds } }, select: { id: true, name: true } });
  const names = new Map(vendors.map((v) => [v.id, v.name]));
  return vendorIds
    .map((vendorId) => {
      const r = rows.get(vendorId);
      const buckets = Object.fromEntries(AGING_BUCKETS.map((k) => [k, num(money(r?.buckets[k] ?? D(0)))])) as Record<AgingBucket, number>;
      const totalDue = AGING_BUCKETS.reduce((a, k) => a.plus(r?.buckets[k] ?? D(0)), D(0));
      const advance = adv.get(vendorId) ?? D(0);
      return { vendorId, vendorName: names.get(vendorId) ?? vendorId, openBills: r?.openBills ?? 0, ...buckets, totalDue: num(money(totalDue)), advances: num(money(advance)), netPayable: num(money(totalDue.minus(advance))) };
    })
    .sort((a, b) => b.netPayable - a.netPayable);
}

export type StatementEntry = { date: string; type: "BILL" | "PAYMENT" | "REVERSAL" | "CANCELLED_BILL"; reference: string; debit: number; credit: number; balance: number; note: string | null };

/**
 * A vendor's account: bills credit the vendor (we owe), payments debit it,
 * reversals credit it back; cancelled bills are listed with no amount. The
 * running balance is what we owe (negative = advance with the vendor).
 */
export async function vendorStatement(db: PrismaClient, ctx: AccessContext, input: { vendorId: string; outletId?: string; from?: Date; to?: Date }) {
  const f = z.object({ vendorId: z.string().min(1), outletId: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(input);
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
  const vendor = await db.vendor.findUnique({ where: { id: f.vendorId }, select: { id: true, name: true, organizationId: true } });
  if (!vendor || vendor.organizationId !== ctx.organizationId) throw new NotFoundError("Vendor not found");
  const [bills, payments] = await Promise.all([
    db.purchaseBill.findMany({ where: { organizationId: ctx.organizationId, vendorId: f.vendorId, outletId: { in: ids } }, select: { id: true, number: true, vendorInvoiceNo: true, billDate: true, total: true, status: true } }),
    db.vendorPayment.findMany({ where: { organizationId: ctx.organizationId, vendorId: f.vendorId, outletId: { in: ids } }, select: { id: true, amount: true, method: true, reference: true, paidAt: true, billId: true, reversedAt: true, reversalReason: true } }),
  ]);
  type Raw = { at: Date; type: StatementEntry["type"]; reference: string; debit: ReturnType<typeof D>; credit: ReturnType<typeof D>; note: string | null };
  const raw: Raw[] = [];
  for (const b of bills) {
    raw.push(b.status === "CANCELLED"
      ? { at: b.billDate, type: "CANCELLED_BILL", reference: b.number, debit: D(0), credit: D(0), note: "Cancelled" }
      : { at: b.billDate, type: "BILL", reference: b.number, debit: D(0), credit: D(b.total), note: b.vendorInvoiceNo ? `Invoice ${b.vendorInvoiceNo}` : null });
  }
  for (const p of payments) {
    raw.push({ at: p.paidAt, type: "PAYMENT", reference: p.reference ?? p.id, debit: D(p.amount), credit: D(0), note: p.billId ? `${p.method} against bill` : `${p.method} advance` });
    if (p.reversedAt) raw.push({ at: p.reversedAt, type: "REVERSAL", reference: p.reference ?? p.id, debit: D(0), credit: D(p.amount), note: p.reversalReason });
  }
  raw.sort((a, b) => a.at.getTime() - b.at.getTime() || a.type.localeCompare(b.type));
  let balance = D(0);
  let opening = D(0);
  const entries: StatementEntry[] = [];
  for (const r of raw) {
    balance = balance.plus(r.credit).minus(r.debit);
    if (f.from && r.at < f.from) { opening = balance; continue; }
    if (f.to && r.at > f.to) continue;
    entries.push({ date: r.at.toISOString(), type: r.type, reference: r.reference, debit: num(money(r.debit)), credit: num(money(r.credit)), balance: num(money(balance)), note: r.note });
  }
  const closing = entries.length ? entries[entries.length - 1].balance : num(money(opening));
  return { vendorId: vendor.id, vendorName: vendor.name, opening: num(money(opening)), closing, entries };
}

/**
 * Reverse a vendor payment (bounced cheque, returned transfer). Needs
 * vendor.pay at the payment's outlet (and, over HTTP, a fresh "finance.void"
 * confirmation). One-shot; the bill's paid amount and status follow.
 */
export async function reverseVendorPayment(ctx: AccessContext, paymentId: string, reason: string, db: Client = prisma) {
  const why = z.string().trim().min(3, "Give a reason").max(300).parse(reason);
  return runInTx(db, async (tx) => {
    const p = await tx.vendorPayment.findUnique({ where: { id: paymentId } });
    if (!p || p.organizationId !== ctx.organizationId) throw new NotFoundError("Vendor payment not found");
    assertOutletAccess(ctx, p.outletId);
    assertCan(ctx, "vendor.pay", p.outletId);
    if (p.reversedAt) throw new ValidationError("This payment is already reversed");
    let billAfter: { status: string; paidAmount: string } | null = null;
    if (p.billId) {
      const bill = await tx.purchaseBill.findUniqueOrThrow({ where: { id: p.billId } });
      const paid = D(bill.paidAmount).minus(D(p.amount));
      if (paid.lt(0)) throw new ValidationError("The bill's paid amount would become negative");
      const status: PurchaseBillStatus = paid.isZero() ? "OPEN" : paid.gte(D(bill.total)) ? "PAID" : "PARTIAL";
      if (status !== bill.status) assertTransition(PURCHASE_BILL_TRANSITIONS, bill.status as PurchaseBillStatus, status, "bill");
      await tx.purchaseBill.update({ where: { id: bill.id }, data: { paidAmount: money(paid), status } });
      billAfter = { status, paidAmount: money(paid).toString() };
    }
    const updated = await tx.vendorPayment.update({ where: { id: paymentId }, data: { reversedAt: new Date(), reversedById: ctx.userId === "system" ? null : ctx.userId, reversalReason: why } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "VendorPayment", entityId: paymentId, outletId: p.outletId, before: { amount: num(p.amount), billId: p.billId }, after: { reversed: true, reason: why, bill: billAfter } });
    return updated;
  });
}
