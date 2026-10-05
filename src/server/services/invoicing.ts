/**
 * Invoices and credit notes — GST-READY data, not certified GST invoicing.
 *
 *  - Every order settled through this system (POS, QR, online) gets ONE invoice
 *    when it becomes PAID: numbered per outlet, per Indian financial year,
 *    gapless and unique ("<series>/<YYyy>/<00001>", ≤ 16 characters). The
 *    counter row is incremented in the settling transaction, so a rolled-back
 *    settlement never consumes a number.
 *  - The invoice freezes the tax breakdown: taxable value and tax per rate
 *    (tax after discount — orders.calculateOrderTotals), split CGST + SGST for
 *    an intra-state supply, IGST for inter-state, nothing for an outlet without
 *    a valid GSTIN; seller and (B2B) buyer GSTIN; place of supply; HSN/SAC.
 *  - Each refund on an invoiced order issues a CREDIT NOTE (own number series)
 *    for the refunded amount, taxable and tax reduced in proportion.
 *  - Orders imported from external platforms (Petpooja, aggregators) are
 *    invoiced by those platforms and are not re-invoiced here.
 *
 * What is NOT here (so no document is called a "GST tax invoice"): e-invoice
 * IRN / signed QR, digital signature, reverse-charge and composition-scheme
 * handling, GSTR filing. See docs/phase4-finance.md.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { withKeyedLock } from "@/server/services/keyedLock";
import { calculateOrderTotals } from "@/server/services/orders";
import { D, money, num } from "@/domain/money";
import { defaultSeries, fiscalYearOf, formatInvoiceNumber, splitTax, supplyTypeOf, validateGstin, type SupplyType } from "@/domain/gst";

/** Sources whose invoices are issued by the external platform, not by us. */
const EXTERNALLY_INVOICED = new Set(["PETPOOJA", "ZOMATO", "SWIGGY"]);

const actor = (ctx: AccessContext) => (ctx.userId === "system" ? null : ctx.userId);

function isoDayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(at);
}

async function nextSeq(tx: Tx, organizationId: string, outletId: string, fiscalYear: string, kind: "INVOICE" | "CREDIT_NOTE") {
  const row = await tx.invoiceSequence.upsert({
    where: { outletId_fiscalYear_kind: { outletId, fiscalYear, kind } },
    create: { organizationId, outletId, fiscalYear, kind, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return row.lastNumber;
}

/** The seller's GST identity for an outlet: its own GSTIN, else the organization's; only a valid one counts. */
async function sellerOf(tx: Tx | PrismaClient, outletId: string) {
  const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: outletId }, include: { organization: { select: { name: true, legalName: true, gstin: true } } } });
  const raw = outlet.gstin ?? outlet.organization.gstin;
  const check = raw ? validateGstin(raw) : null;
  return {
    outlet,
    name: outlet.organization.legalName || outlet.organization.name,
    gstin: check?.valid ? check.gstin : null,
    stateCode: check?.valid ? check.stateCode : null,
    series: outlet.invoiceSeries || defaultSeries(outlet.code),
  };
}

/**
 * Per-rate taxable value + tax for an order, reconciled to the order's
 * persisted tax (orders priced before the tax-after-discount rule keep their
 * original tax; the rounding residue goes to the largest rate).
 */
function rateLines(order: { tax: unknown; discount: unknown; items: Array<{ qty: unknown; unitPrice: unknown; discount: unknown; taxPct: unknown; hsnSac: string | null; modifiers: Array<{ priceDelta: unknown }> }> }) {
  const totals = calculateOrderTotals(
    order.items.map((it) => ({ qty: it.qty as never, unitPrice: it.unitPrice as never, discount: it.discount as never, taxPct: it.taxPct as never, modifiersPerUnit: it.modifiers.reduce((a, m) => a.plus(D(m.priceDelta as never)), D(0)) })),
    order.discount as never
  );
  const rows = totals.byRate.map((r) => {
    const codes = new Set(order.items.filter((it) => D(it.taxPct as never).eq(r.ratePct)).map((it) => it.hsnSac ?? ""));
    return { ratePct: r.ratePct, taxable: r.taxable, tax: r.tax, hsnSac: codes.size === 1 ? [...codes][0] || null : null };
  });
  const residue = money(D(order.tax as never)).minus(rows.reduce((a, r) => a.plus(r.tax), D(0)));
  if (!residue.isZero() && rows.length) {
    const largest = rows.reduce((a, r) => (r.tax.gt(a.tax) ? r : a));
    largest.tax = largest.tax.plus(residue);
  }
  return rows;
}

const invoiceInclude = { lines: { orderBy: { ratePct: "asc" as const } } };

/**
 * Issue the order's invoice (inside the settling transaction). Idempotent: the
 * unique sourceKey "inv:<orderId>" means at most one invoice per order.
 * Returns null for orders invoiced by an external platform.
 */
export async function issueInvoiceTx(tx: Tx, ctx: AccessContext, orderId: string) {
  const sourceKey = `inv:${orderId}`;
  const existing = await tx.taxInvoice.findUnique({ where: { sourceKey }, include: invoiceInclude });
  if (existing) return existing;
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { modifiers: true } } } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  if (EXTERNALLY_INVOICED.has(order.source)) return null;
  if (order.status !== "PAID" && order.status !== "REFUNDED") throw new ValidationError("Only a paid order is invoiced");

  const seller = await sellerOf(tx, order.outletId);
  const buyer = order.buyerGstin ? validateGstin(order.buyerGstin) : null;
  if (buyer && !buyer.valid) throw new ValidationError(`Buyer GSTIN: ${buyer.reason}`);
  const supplyType: SupplyType = supplyTypeOf(seller.stateCode, seller.stateCode); // restaurant service: place of supply = the outlet
  const fiscalYear = fiscalYearOf(isoDayIn(new Date(), seller.outlet.timezone));
  const seq = await nextSeq(tx, ctx.organizationId, order.outletId, fiscalYear, "INVOICE");
  const number = formatInvoiceNumber(seller.series, fiscalYear, seq);
  const rows = rateLines(order);
  const parts = rows.map((r) => ({ ...r, ...splitTax(r.tax, supplyType) }));
  const sum = (k: "cgst" | "sgst" | "igst") => parts.reduce((a, p) => a.plus(p[k]), D(0));

  const invoice = await tx.taxInvoice.create({
    data: {
      organizationId: ctx.organizationId, outletId: order.outletId, orderId, kind: "INVOICE", number, fiscalYear, seq, sourceKey,
      sellerName: seller.name, sellerAddress: seller.outlet.address, sellerGstin: seller.gstin, sellerStateCode: seller.stateCode,
      buyerName: order.buyerName, buyerGstin: buyer?.valid ? buyer.gstin : null, placeOfSupply: seller.stateCode, supplyType,
      taxableValue: money(rows.reduce((a, r) => a.plus(r.taxable), D(0))), cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"),
      totalTax: money(D(order.tax)), total: money(D(order.total)), createdById: actor(ctx),
      lines: { create: parts.map((p) => ({ organizationId: ctx.organizationId, ratePct: p.ratePct, hsnSac: p.hsnSac, taxableValue: p.taxable, cgst: p.cgst, sgst: p.sgst, igst: p.igst })) },
    },
    include: invoiceInclude,
  });
  await tx.order.update({ where: { id: orderId }, data: { invoiceNo: number } });
  await writeAudit(tx, ctx, { action: "CREATE", entityType: "TaxInvoice", entityId: invoice.id, outletId: order.outletId, after: { number, orderId, total: num(invoice.total), supplyType } });
  return invoice;
}

/**
 * Credit note for a refund on an invoiced order (inside the refund's
 * transaction): the refunded amount, with taxable value and each tax component
 * reduced in proportion to the invoice; the rounding residue goes to the
 * taxable value so taxable + tax = the refund exactly. One per refund.
 */
export async function issueCreditNoteTx(tx: Tx, ctx: AccessContext, refund: { id: string; amount: unknown; paymentId: string }, reason?: string) {
  const sourceKey = `cn:${refund.id}`;
  const existing = await tx.taxInvoice.findUnique({ where: { sourceKey } });
  if (existing) return existing;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId }, select: { orderId: true } });
  const invoice = await tx.taxInvoice.findUnique({ where: { sourceKey: `inv:${payment.orderId}` }, include: { lines: true } });
  if (!invoice) return null; // not invoiced here (e.g. external platform order)
  const amount = money(D(refund.amount as never));
  const ratio = D(invoice.total).isZero() ? D(0) : amount.div(D(invoice.total));
  const lines = invoice.lines.map((l) => ({
    ratePct: l.ratePct, hsnSac: l.hsnSac,
    taxable: money(D(l.taxableValue).times(ratio)), cgst: money(D(l.cgst).times(ratio)), sgst: money(D(l.sgst).times(ratio)), igst: money(D(l.igst).times(ratio)),
  }));
  const tax = lines.reduce((a, l) => a.plus(l.cgst).plus(l.sgst).plus(l.igst), D(0));
  const residue = amount.minus(tax).minus(lines.reduce((a, l) => a.plus(l.taxable), D(0)));
  if (lines.length && !residue.isZero()) {
    const largest = lines.reduce((a, l) => (l.taxable.gt(a.taxable) ? l : a));
    largest.taxable = largest.taxable.plus(residue);
  }
  const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: invoice.outletId }, select: { code: true, invoiceSeries: true, timezone: true } });
  const fiscalYear = fiscalYearOf(isoDayIn(new Date(), outlet.timezone));
  const seq = await nextSeq(tx, ctx.organizationId, invoice.outletId, fiscalYear, "CREDIT_NOTE");
  const number = formatInvoiceNumber(outlet.invoiceSeries || defaultSeries(outlet.code), fiscalYear, seq, "CREDIT_NOTE");
  const sum = (k: "cgst" | "sgst" | "igst") => lines.reduce((a, l) => a.plus(l[k]), D(0));
  const note = await tx.taxInvoice.create({
    data: {
      organizationId: ctx.organizationId, outletId: invoice.outletId, orderId: invoice.orderId, kind: "CREDIT_NOTE", number, fiscalYear, seq, sourceKey,
      originalInvoiceId: invoice.id, refundId: refund.id, reason: reason ?? null,
      sellerName: invoice.sellerName, sellerAddress: invoice.sellerAddress, sellerGstin: invoice.sellerGstin, sellerStateCode: invoice.sellerStateCode,
      buyerName: invoice.buyerName, buyerGstin: invoice.buyerGstin, placeOfSupply: invoice.placeOfSupply, supplyType: invoice.supplyType,
      taxableValue: lines.reduce((a, l) => a.plus(l.taxable), D(0)), cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), totalTax: tax, total: amount, createdById: actor(ctx),
      lines: { create: lines.map((l) => ({ organizationId: ctx.organizationId, ratePct: l.ratePct, hsnSac: l.hsnSac, taxableValue: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst })) },
    },
  });
  await writeAudit(tx, ctx, { action: "CREATE", entityType: "TaxInvoice", entityId: note.id, outletId: invoice.outletId, after: { kind: "CREDIT_NOTE", number, against: invoice.number, amount: num(amount), refundId: refund.id } });
  return note;
}

// ---------------- commands ----------------

/** Issue the invoice for an already-paid order that has none (e.g. paid before invoicing existed). */
export async function issueInvoice(ctx: AccessContext, orderId: string, db: Client = prisma) {
  // Same per-outlet queue as settlement (it increments the same invoice counter): keyedLock.ts.
  const at = "$transaction" in db ? await db.order.findUnique({ where: { id: orderId }, select: { outletId: true } }) : null;
  const run = () => runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { organizationId: true, outletId: true } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "payment.take", order.outletId);
    const invoice = await issueInvoiceTx(tx, ctx, orderId);
    if (!invoice) throw new ValidationError("This order is invoiced by its ordering platform");
    return invoice;
  });
  return at ? withKeyedLock(`settle:${at.outletId}`, run) : run();
}

const buyerSchema = z.object({ gstin: z.string().trim().max(15).nullable().optional(), name: z.string().trim().min(1).max(120).nullable().optional() }).strict();

/** B2B: record the buyer's GSTIN / name before the invoice is issued (an issued invoice is never edited). */
export async function setOrderBuyer(ctx: AccessContext, orderId: string, input: z.input<typeof buyerSchema>, db: Client = prisma) {
  const data = buyerSchema.parse(input);
  let gstin: string | null | undefined = data.gstin;
  if (gstin) {
    const check = validateGstin(gstin);
    if (!check.valid) throw new ValidationError(`Buyer GSTIN: ${check.reason}`);
    gstin = check.gstin;
  }
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.modify", order.outletId);
    if (order.invoiceNo || ["PAID", "CANCELLED", "REFUNDED"].includes(order.status)) throw new ValidationError("Buyer details can only be set before the order is paid and invoiced");
    const updated = await tx.order.update({ where: { id: orderId }, data: { ...(gstin !== undefined ? { buyerGstin: gstin } : {}), ...(data.name !== undefined ? { buyerName: data.name } : {}) } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { buyerGstin: order.buyerGstin, buyerName: order.buyerName }, after: { buyerGstin: updated.buyerGstin, buyerName: updated.buyerName } });
    return updated;
  });
}

// ---------------- queries ----------------

export async function getOrderInvoices(db: PrismaClient | Tx, orderId: string) {
  return db.taxInvoice.findMany({ where: { orderId }, include: invoiceInclude, orderBy: [{ issuedAt: "asc" }, { seq: "asc" }] });
}

const listSchema = z.object({ outletId: z.string().min(1), kind: z.enum(["INVOICE", "CREDIT_NOTE"]).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), take: z.coerce.number().int().positive().max(500).default(100) });

export async function listInvoices(db: PrismaClient, ctx: AccessContext, input: z.input<typeof listSchema>) {
  const f = listSchema.parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "finance.view", f.outletId);
  await assertOutletInOrg(db, ctx, f.outletId); // another tenant's outlet id: 404, not an empty list
  return db.taxInvoice.findMany({
    where: { organizationId: ctx.organizationId, outletId: f.outletId, ...(f.kind ? { kind: f.kind } : {}), ...(f.from || f.to ? { issuedAt: { gte: f.from, lte: f.to } } : {}) },
    orderBy: [{ issuedAt: "desc" }, { seq: "desc" }],
    take: f.take,
    include: invoiceInclude,
  });
}

export type TaxSummaryRow = { kind: string; ratePct: number; documents: number; taxableValue: number; cgst: number; sgst: number; igst: number; totalTax: number };

/**
 * Tax summary per document kind and rate for a period (GST-return-ready data:
 * invoices positive, credit notes listed separately to net off).
 */
export async function taxSummary(db: PrismaClient, ctx: AccessContext, filter: { outletIds: string[]; from?: Date; to?: Date }): Promise<TaxSummaryRow[]> {
  if (!filter.outletIds.length) return [];
  const lines = await db.taxInvoiceLine.findMany({
    where: { organizationId: ctx.organizationId, invoice: { outletId: { in: filter.outletIds }, ...(filter.from || filter.to ? { issuedAt: { gte: filter.from, lte: filter.to } } : {}) } },
    select: { ratePct: true, taxableValue: true, cgst: true, sgst: true, igst: true, invoiceId: true, invoice: { select: { kind: true } } },
  });
  const acc = new Map<string, { kind: string; ratePct: ReturnType<typeof D>; docs: Set<string>; taxable: ReturnType<typeof D>; cgst: ReturnType<typeof D>; sgst: ReturnType<typeof D>; igst: ReturnType<typeof D> }>();
  for (const l of lines) {
    const k = `${l.invoice.kind}|${D(l.ratePct).toString()}`;
    const a = acc.get(k) ?? { kind: l.invoice.kind, ratePct: D(l.ratePct), docs: new Set(), taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) };
    a.docs.add(l.invoiceId);
    a.taxable = a.taxable.plus(D(l.taxableValue));
    a.cgst = a.cgst.plus(D(l.cgst));
    a.sgst = a.sgst.plus(D(l.sgst));
    a.igst = a.igst.plus(D(l.igst));
    acc.set(k, a);
  }
  return [...acc.values()]
    .map((a) => ({ kind: a.kind, ratePct: num(a.ratePct), documents: a.docs.size, taxableValue: num(money(a.taxable)), cgst: num(money(a.cgst)), sgst: num(money(a.sgst)), igst: num(money(a.igst)), totalTax: num(money(a.cgst.plus(a.sgst).plus(a.igst))) }))
    .sort((x, y) => x.kind.localeCompare(y.kind) || x.ratePct - y.ratePct);
}
