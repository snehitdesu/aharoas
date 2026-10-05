/**
 * Accounting export (Phase 7). Builds balanced double-entry vouchers FROM the
 * existing finance records — nothing is recalculated:
 *
 *   SALES            issued tax invoice (taxable + CGST/SGST/IGST as frozen on it);
 *                    a settled order with no invoice (external platform orders)
 *                    uses the order's own total / tax
 *   CREDIT_NOTE      issued credit note (refund of an invoiced order)
 *   RECEIPT / REFUND customer payments collected / refunds issued, per method
 *   EXPENSE          non-void expense; EXPENSE_VOID reverses one voided after export
 *   PURCHASE         vendor bill (subtotal + input tax); PURCHASE_CANCEL reverses
 *                    one cancelled after export
 *   VENDOR_PAYMENT   vendor payment; VENDOR_PAYMENT_REVERSAL reverses one reversed
 *                    after export
 *
 * Duplicate protection: every voucher has a stable sourceKey and is exported
 * once per format (IntegrationDelivery `acct:<format>:<sourceKey>`); a later
 * export only contains what is new (and reversals of what changed). A batch can
 * be downloaded again (same bytes). Reconciliation compares the batch's totals
 * with the finance figures for the same period.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { runInTx } from "@/server/services/_workflow";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { authorizedOutletIds } from "@/server/services/analytics";
import { taxSummary } from "@/server/services/invoicing";
import { localDate } from "@/domain/time";
import { D, money, num } from "@/domain/money";
import { getAccountingFormat, isBalanced, ordered, type Voucher, type VoucherLine } from "@/integrations/accounting";

const m2 = (v: unknown) => num(money(D(v as never)));
const dr = (ledger: string, amount: number): VoucherLine => ({ ledger, debit: amount, credit: 0 });
const cr = (ledger: string, amount: number): VoucherLine => ({ ledger, debit: 0, credit: amount });
const cashLedger = (method: string) => (method === "CASH" || method === "PETTY_CASH" ? "Cash" : `Bank - ${method}`);
const reverse = (v: Voucher, type: Voucher["type"], key: string, date: string, narration: string): Voucher => ({ ...v, sourceKey: key, type, date, narration, number: `${v.number}-R`, lines: v.lines.map((l) => ({ ledger: l.ledger, debit: l.credit, credit: l.debit })) });

const exportSchema = z.object({
  format: z.enum(["generic", "tally"]).default("generic"),
  outletId: z.string().min(1).optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
}).refine((f) => f.from <= f.to, { message: "`from` must be on or before `to`" }).refine((f) => f.to.getTime() - f.from.getTime() <= 400 * 86400000, { message: "At most 400 days per export" });

/** All vouchers for the period (current state of the books). */
export async function buildVouchers(db: PrismaClient, ctx: AccessContext, ids: string[], range: { from: Date; to: Date }) {
  const tz = new Map((await db.outlet.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, timezone: true } })).map((o) => [o.id, o.timezone]));
  const day = (d: Date, outletId: string) => localDate(d, tz.get(outletId) ?? "Asia/Kolkata");
  const scope = { organizationId: ctx.organizationId, outletId: { in: ids } };
  const at = { gte: range.from, lte: range.to };
  const [docs, uninvoicedAll, payments, refunds, expenses, bills, vpays] = await Promise.all([
    db.taxInvoice.findMany({ where: { ...scope, issuedAt: at }, select: { id: true, kind: true, number: true, outletId: true, issuedAt: true, taxableValue: true, cgst: true, sgst: true, igst: true, total: true, buyerName: true } }),
    db.order.findMany({ where: { ...scope, status: { in: ["PAID", "REFUNDED"] }, paidAt: at }, select: { id: true, outletId: true, paidAt: true, total: true, tax: true, source: true } }),
    db.payment.findMany({ where: { ...scope, status: { in: ["SUCCESS", "PARTIAL", "REFUNDED"] }, createdAt: at }, select: { id: true, outletId: true, createdAt: true, amount: true, method: true, orderId: true } }),
    db.refund.findMany({ where: { ...scope, createdAt: at }, select: { id: true, outletId: true, createdAt: true, amount: true, payment: { select: { method: true, orderId: true } } } }),
    db.expense.findMany({ where: { ...scope, spentAt: at }, select: { id: true, outletId: true, spentAt: true, amount: true, category: true, paidVia: true, description: true, voidedAt: true } }),
    db.purchaseBill.findMany({ where: { ...scope, billDate: at }, select: { id: true, outletId: true, number: true, billDate: true, subtotal: true, tax: true, total: true, status: true, updatedAt: true, vendorId: true } }),
    db.vendorPayment.findMany({ where: { ...scope, paidAt: at }, select: { id: true, outletId: true, paidAt: true, amount: true, method: true, vendorId: true, reference: true, reversedAt: true } }),
  ]);
  // Settled orders that never got a tax invoice here (external platform orders) — sales from the order itself.
  const invoiced = new Set((await db.taxInvoice.findMany({ where: { organizationId: ctx.organizationId, kind: "INVOICE", orderId: { in: uninvoicedAll.map((o) => o.id) } }, select: { orderId: true } })).map((i) => i.orderId));
  const uninvoiced = uninvoicedAll.filter((o) => !invoiced.has(o.id));
  const vendorIds = [...new Set([...bills.map((b) => b.vendorId), ...vpays.map((p) => p.vendorId)])];
  const vendors = new Map((await db.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: vendorIds } }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));
  const ref = (id: string) => id.slice(-6).toUpperCase();

  const current: Voucher[] = [];
  /** Vouchers for documents now voided / cancelled / reversed: emitted only if the original was exported. */
  const reversals: Array<{ originalKey: string; voucher: Voucher }> = [];

  for (const d of docs) {
    const taxable = m2(d.taxableValue);
    const lines = [dr("Sales Receivable", m2(d.total)), cr("Sales", taxable), ...(m2(d.cgst) ? [cr("Output CGST", m2(d.cgst))] : []), ...(m2(d.sgst) ? [cr("Output SGST", m2(d.sgst))] : []), ...(m2(d.igst) ? [cr("Output IGST", m2(d.igst))] : [])];
    const v: Voucher = { sourceKey: `${d.kind === "INVOICE" ? "inv" : "cn"}:${d.id}`, date: day(d.issuedAt, d.outletId), type: d.kind === "INVOICE" ? "SALES" : "CREDIT_NOTE", number: d.number, party: d.buyerName ?? undefined, narration: d.kind === "INVOICE" ? "Sales invoice" : "Credit note (refund)", lines };
    current.push(d.kind === "INVOICE" ? v : { ...v, lines: lines.map((l) => ({ ledger: l.ledger, debit: l.credit, credit: l.debit })) });
  }
  for (const o of uninvoiced) {
    const total = m2(o.total);
    const tax = m2(o.tax);
    current.push({ sourceKey: `ord:${o.id}`, date: day(o.paidAt!, o.outletId), type: "SALES", number: `ORD-${ref(o.id)}`, narration: `Sales (${o.source}, no tax invoice issued here)`, lines: [dr("Sales Receivable", total), cr("Sales", m2(D(total).minus(tax))), ...(tax ? [cr("Output GST", tax)] : [])] });
  }
  for (const p of payments) current.push({ sourceKey: `pay:${p.id}`, date: day(p.createdAt, p.outletId), type: "RECEIPT", number: `PAY-${ref(p.id)}`, narration: `Payment ${p.method} for order ${ref(p.orderId)}`, lines: [dr(cashLedger(p.method), m2(p.amount)), cr("Sales Receivable", m2(p.amount))] });
  for (const r of refunds) current.push({ sourceKey: `rf:${r.id}`, date: day(r.createdAt, r.outletId), type: "REFUND", number: `RF-${ref(r.id)}`, narration: `Refund ${r.payment.method} for order ${ref(r.payment.orderId)}`, lines: [dr("Sales Receivable", m2(r.amount)), cr(cashLedger(r.payment.method), m2(r.amount))] });
  for (const e of expenses) {
    const v: Voucher = { sourceKey: `exp:${e.id}`, date: day(e.spentAt, e.outletId), type: "EXPENSE", number: `EXP-${ref(e.id)}`, narration: (e.description ?? e.category).slice(0, 120), lines: [dr(`Expense - ${e.category}`, m2(e.amount)), cr(cashLedger(e.paidVia), m2(e.amount))] };
    if (e.voidedAt) reversals.push({ originalKey: v.sourceKey, voucher: reverse(v, "EXPENSE_VOID", `expv:${e.id}`, day(e.voidedAt, e.outletId), "Expense voided") });
    else current.push(v);
  }
  for (const b of bills) {
    const party = vendors.get(b.vendorId) ?? "Vendor";
    const v: Voucher = { sourceKey: `bill:${b.id}`, date: day(b.billDate, b.outletId), type: "PURCHASE", number: b.number, party, narration: "Vendor bill", lines: [dr("Purchases", m2(b.subtotal)), ...(m2(b.tax) ? [dr("Input GST", m2(b.tax))] : []), cr(`Vendor - ${party}`, m2(b.total))] };
    if (b.status === "CANCELLED") reversals.push({ originalKey: v.sourceKey, voucher: reverse(v, "PURCHASE_CANCEL", `billx:${b.id}`, day(b.updatedAt, b.outletId), "Vendor bill cancelled") });
    else current.push(v);
  }
  for (const p of vpays) {
    const party = vendors.get(p.vendorId) ?? "Vendor";
    const v: Voucher = { sourceKey: `vp:${p.id}`, date: day(p.paidAt, p.outletId), type: "VENDOR_PAYMENT", number: p.reference ?? `VP-${ref(p.id)}`, party, narration: `Vendor payment ${p.method}`, lines: [dr(`Vendor - ${party}`, m2(p.amount)), cr(cashLedger(p.method), m2(p.amount))] };
    if (p.reversedAt) reversals.push({ originalKey: v.sourceKey, voucher: reverse(v, "VENDOR_PAYMENT_REVERSAL", `vpr:${p.id}`, day(p.reversedAt, p.outletId), "Vendor payment reversed") });
    else current.push(v);
  }
  for (const v of current) if (!isBalanced(v)) throw new ValidationError(`Voucher ${v.number} does not balance`);
  return { current, reversals };
}

/**
 * Export everything not yet exported in this format for the period. Returns
 * the file (or `empty: true`) plus a reconciliation of the batch with the
 * finance figures.
 */
export async function exportAccounting(ctx: AccessContext, input: z.input<typeof exportSchema>, db: PrismaClient = prisma) {
  const f = exportSchema.parse(input);
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
  assertCan(ctx, "export.run", f.outletId);
  if (!ids.length) throw new ValidationError("No outlet to export");
  const fmt = getAccountingFormat(f.format);
  const { current, reversals } = await buildVouchers(db, ctx, ids, f);
  const keyOf = (sourceKey: string) => `acct:${fmt.name}:${sourceKey}`;
  const known = new Map((await db.integrationDelivery.findMany({ where: { organizationId: ctx.organizationId, kind: "ACCOUNTING_VOUCHER", idempotencyKey: { in: [...current.map((v) => keyOf(v.sourceKey)), ...reversals.flatMap((r) => [keyOf(r.originalKey), keyOf(r.voucher.sourceKey)])] } }, select: { idempotencyKey: true, status: true } })).map((d) => [d.idempotencyKey, d.status]));
  const exported = (k: string) => known.get(keyOf(k)) === "SENT";
  const batch = [...current.filter((v) => !exported(v.sourceKey)), ...reversals.filter((r) => exported(r.originalKey) && !exported(r.voucher.sourceKey)).map((r) => r.voucher)];
  const skipped = current.length - current.filter((v) => !exported(v.sourceKey)).length;
  if (!batch.length) return { empty: true as const, format: fmt.name, skippedAlreadyExported: skipped };

  const batchId = randomUUID();
  const file = fmt.render(batch);
  const checksum = createHash("sha256").update(file).digest("hex");
  // Claim the batch atomically: the "already exported" read above ran outside any
  // transaction, so a concurrent export of the same period may have sent some of
  // these vouchers meanwhile. Re-check inside a SERIALIZABLE transaction (two
  // overlapping claims of a voucher cannot both commit) and refuse rather than
  // hand the same voucher to the accounting system twice.
  await runInTx(db, async (tx) => {
    const raced = await tx.integrationDelivery.count({ where: { organizationId: ctx.organizationId, kind: "ACCOUNTING_VOUCHER", status: "SENT", idempotencyKey: { in: batch.map((v) => keyOf(v.sourceKey)) } } });
    if (raced) throw new ConflictError("Another export just exported some of these vouchers; run the export again");
    for (const v of ordered(batch)) {
      const data = { status: "SENT", payload: JSON.stringify(v), batchId, providerRef: batchId, sentAt: new Date(), attempts: 1, lastError: null };
      await tx.integrationDelivery.upsert({
        where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: keyOf(v.sourceKey) } },
        create: { organizationId: ctx.organizationId, outletId: f.outletId ?? null, kind: "ACCOUNTING_VOUCHER", provider: fmt.name, mode: "LIVE", idempotencyKey: keyOf(v.sourceKey), sourceType: v.type, sourceId: v.sourceKey, ...data },
        update: data,
      });
    }
    await writeAudit(tx, ctx, { action: "INTEGRATION_SYNC", entityType: "AccountingExport", entityId: batchId, outletId: f.outletId, after: { format: fmt.name, from: f.from.toISOString(), to: f.to.toISOString(), vouchers: batch.length, skippedAlreadyExported: skipped, checksum } });
  });
  return { empty: false as const, batchId, format: fmt.name, filename: `accounting-${fmt.name}-${f.from.toISOString().slice(0, 10)}-${f.to.toISOString().slice(0, 10)}-${batchId.slice(0, 8)}.${fmt.extension}`, mime: fmt.mime, file, checksum, vouchers: batch.length, skippedAlreadyExported: skipped, reconciliation: await reconcile(db, ctx, ids, f, batch) };
}

/** Download an earlier batch again (byte-identical). */
export async function accountingBatch(ctx: AccessContext, batchId: string, db: PrismaClient = prisma) {
  assertCan(ctx, "export.run");
  assertCan(ctx, "finance.view");
  const rows = await db.integrationDelivery.findMany({ where: { organizationId: ctx.organizationId, kind: "ACCOUNTING_VOUCHER", batchId } });
  if (!rows.length) throw new NotFoundError("Export batch not found");
  const fmt = getAccountingFormat(rows[0].provider);
  const file = fmt.render(rows.map((r) => JSON.parse(r.payload) as Voucher));
  return { batchId, format: fmt.name, mime: fmt.mime, file, checksum: createHash("sha256").update(file).digest("hex"), vouchers: rows.length };
}

/** Totals of the batch by voucher type vs the finance figures for the same period (first export of a period should match exactly). */
async function reconcile(db: PrismaClient, ctx: AccessContext, ids: string[], range: { from: Date; to: Date }, batch: Voucher[]) {
  const sum = (type: Voucher["type"], ledger: string, side: "debit" | "credit") => m2(batch.filter((v) => v.type === type).reduce((a, v) => a + v.lines.filter((l) => l.ledger === ledger).reduce((s, l) => s + l[side], 0), 0));
  const tax = await taxSummary(db, ctx, { outletIds: ids, from: range.from, to: range.to });
  const scope = { organizationId: ctx.organizationId, outletId: { in: ids } };
  const [collected, refunded, expenses] = await Promise.all([
    db.payment.aggregate({ where: { ...scope, status: { in: ["SUCCESS", "PARTIAL", "REFUNDED"] }, createdAt: { gte: range.from, lte: range.to } }, _sum: { amount: true } }),
    db.refund.aggregate({ where: { ...scope, createdAt: { gte: range.from, lte: range.to } }, _sum: { amount: true } }),
    db.expense.aggregate({ where: { ...scope, voidedAt: null, spentAt: { gte: range.from, lte: range.to } }, _sum: { amount: true } }),
  ]);
  const invoiceTaxable = m2(tax.filter((t) => t.kind === "INVOICE").reduce((a, t) => a + t.taxableValue, 0));
  const checks = [
    { check: "Invoiced taxable value", exported: m2(batch.filter((v) => v.type === "SALES" && v.sourceKey.startsWith("inv:")).reduce((a, v) => a + v.lines.filter((l) => l.ledger === "Sales").reduce((s, l) => s + l.credit, 0), 0)), finance: invoiceTaxable },
    { check: "Payments collected", exported: sum("RECEIPT", "Sales Receivable", "credit"), finance: m2(collected._sum.amount ?? 0) },
    { check: "Refunds", exported: sum("REFUND", "Sales Receivable", "debit"), finance: m2(refunded._sum.amount ?? 0) },
    { check: "Expenses (non-void)", exported: m2(batch.filter((v) => v.type === "EXPENSE").reduce((a, v) => a + v.lines.reduce((s, l) => s + l.debit, 0), 0)), finance: m2(expenses._sum.amount ?? 0) },
  ];
  return checks.map((c) => ({ ...c, matches: Math.round(c.exported * 100) === Math.round(c.finance * 100) }));
}
