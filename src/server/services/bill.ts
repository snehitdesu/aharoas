/**
 * Bill / receipt for an order — a deterministic rendering of the server's
 * order, never stored separately, so a reprint is always identical to the
 * first print and there is nothing to "generate twice".
 *
 * This is a restaurant bill / payment receipt. Once the order is paid it also
 * carries its invoice (services/invoicing.ts): sequential number, seller /
 * buyer GSTIN, CGST/SGST/IGST per rate, HSN/SAC, credit notes. That is
 * GST-READY data; the document is still not presented as a certified GST tax
 * invoice (no e-invoice IRN / digital signature — docs/phase4-finance.md).
 *
 * All amounts come from the persisted, server-calculated order (orders.ts
 * calculateOrderTotals) and its payments/refunds; nothing is taken from a client.
 */
import type { PrismaClient } from "@prisma/client";
import { type AccessContext, NotFoundError, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { D, money, type Decimalish } from "@/domain/money";
import { calculateOrderTotals } from "@/server/services/orders";
import { fulfilmentStage, type FulfilmentStage } from "@/domain/orderProgress";
import { getOrderInvoices } from "@/server/services/invoicing";

export type BillPaymentStatus = "UNPAID" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "CANCELLED";

export type Bill = {
  kind: "BILL" | "RECEIPT";
  billNo: string;
  orderId: string;
  restaurant: { name: string; outletName: string; address: string | null; phone: string | null; timezone: string; currency: string };
  table: string | null;
  channel: string;
  source: string;
  covers: number;
  orderStatus: string;
  fulfilment: FulfilmentStage;
  createdAt: string;
  paidAt: string | null;
  lines: Array<{ name: string; qty: string; unitPrice: string; modifiers: Array<{ name: string; priceDelta: string }>; discount: string; taxPct: string; lineTotal: string; notes: string | null }>;
  subtotal: string;
  discount: string;
  taxes: Array<{ ratePct: string; taxable: string; amount: string }>;
  tax: string;
  total: string;
  payments: Array<{ method: string; status: string; amount: string; at: string }>;
  refunds: Array<{ amount: string; at: string }>;
  paid: string;
  refunded: string;
  balanceDue: string;
  paymentStatus: BillPaymentStatus;
  /** The order's invoice once issued (paid orders), with its GST breakdown. */
  invoice: BillInvoice | null;
  creditNotes: Array<{ number: string; issuedAt: string; total: string; reason: string | null }>;
};

export type BillInvoice = {
  number: string;
  issuedAt: string;
  supplyType: string;
  sellerGstin: string | null;
  buyerGstin: string | null;
  buyerName: string | null;
  placeOfSupply: string | null;
  lines: Array<{ ratePct: string; hsnSac: string | null; taxable: string; cgst: string; sgst: string; igst: string }>;
};

/** TaxInvoice rows as loaded with their lines (services/invoicing.ts). */
type InvoiceRow = { kind: string; number: string; issuedAt: Date; supplyType: string; sellerGstin: string | null; buyerGstin: string | null; buyerName: string | null; placeOfSupply: string | null; total: Decimalish; reason: string | null; lines: Array<{ ratePct: Decimalish; hsnSac: string | null; taxableValue: Decimalish; cgst: Decimalish; sgst: Decimalish; igst: Decimalish }> };

/** The relations buildBill needs (getOrder-shaped). */
export type BillOrder = {
  id: string;
  invoiceNo: string | null;
  status: string;
  channel: string;
  source: string;
  covers: number;
  createdAt: Date;
  paidAt: Date | null;
  subtotal: Decimalish;
  discount: Decimalish;
  tax: Decimalish;
  total: Decimalish;
  table: { code: string } | null;
  items: Array<{ name: string; qty: Decimalish; unitPrice: Decimalish; discount: Decimalish; taxPct: Decimalish; lineTotal: Decimalish; notes: string | null; modifiers: Array<{ name: string; priceDelta: Decimalish }> }>;
  payments: Array<{ method: string; status: string; amount: Decimalish; createdAt: Date; verifiedAt: Date | null; refunds: Array<{ amount: Decimalish; createdAt: Date }> }>;
  kots: Array<{ status: string }>;
};

export type BillVenue = { organization: { name: string; legalName: string | null }; outlet: { name: string; address: string | null; phone: string | null; timezone: string; currency: string } };

const m2 = (v: Decimalish) => money(v).toFixed(2);

/** Short human reference for an order (also used by the POS and KDS). */
export const orderRef = (id: string) => id.slice(-6).toUpperCase();

/**
 * Tax per rate, taxable value after the order discount (orders.calculateOrderTotals
 * — the same breakdown the invoice freezes). Orders priced under an earlier rule
 * keep their persisted tax: any rounding residue goes on the largest rate so the
 * breakdown always sums to the order's tax.
 */
function taxBreakdown(order: BillOrder) {
  const totals = calculateOrderTotals(
    order.items.map((it) => ({ qty: it.qty, unitPrice: it.unitPrice, discount: it.discount, taxPct: it.taxPct, modifiersPerUnit: it.modifiers.reduce((a, m) => a.plus(D(m.priceDelta)), D(0)) })),
    order.discount
  );
  const rows = totals.byRate.filter((r) => !r.ratePct.isZero()).map((r) => ({ rate: r.ratePct, taxable: r.taxable, amount: r.tax }));
  const residue = money(order.tax).minus(rows.reduce((a, r) => a.plus(r.amount), D(0)));
  if (!residue.isZero() && rows.length) {
    const largest = rows.reduce((a, r) => (r.amount.gt(a.amount) ? r : a));
    largest.amount = largest.amount.plus(residue);
  }
  return rows.map((r) => ({ ratePct: r.rate.toString(), taxable: r.taxable.toFixed(2), amount: r.amount.toFixed(2) }));
}

export function buildBill(order: BillOrder, venue: BillVenue, invoices: InvoiceRow[] = []): Bill {
  const inv = invoices.find((i) => i.kind === "INVOICE") ?? null;
  // Collected money: SUCCESS + PARTIAL (partially refunded) at full amount —
  // the payment service's outstanding-balance rule; refunds are listed apart.
  const held = order.payments.filter((p) => p.status === "SUCCESS" || p.status === "PARTIAL");
  const settled = order.payments.filter((p) => p.status === "SUCCESS" || p.status === "PARTIAL" || p.status === "REFUNDED");
  const paid = settled.reduce((a, p) => a.plus(D(p.amount)), D(0));
  const refunds = settled.flatMap((p) => p.refunds);
  const refunded = refunds.reduce((a, r) => a.plus(D(r.amount)), D(0));
  const closed = ["CANCELLED", "REFUNDED"].includes(order.status);
  const balance = closed ? D(0) : D(order.total).minus(held.reduce((a, p) => a.plus(D(p.amount)), D(0)));

  let paymentStatus: BillPaymentStatus;
  if (order.status === "CANCELLED") paymentStatus = "CANCELLED";
  else if (order.status === "REFUNDED") paymentStatus = "REFUNDED";
  else if (order.status === "PAID") paymentStatus = refunded.gt(0) ? "PARTIALLY_REFUNDED" : "PAID";
  else paymentStatus = paid.gt(0) ? "PARTIALLY_PAID" : "UNPAID";

  return {
    kind: order.status === "PAID" || order.status === "REFUNDED" ? "RECEIPT" : "BILL",
    billNo: inv?.number ?? order.invoiceNo ?? orderRef(order.id),
    orderId: order.id,
    restaurant: {
      name: venue.organization.legalName || venue.organization.name,
      outletName: venue.outlet.name,
      address: venue.outlet.address,
      phone: venue.outlet.phone,
      timezone: venue.outlet.timezone,
      currency: venue.outlet.currency,
    },
    table: order.table?.code ?? null,
    channel: order.channel,
    source: order.source,
    covers: order.covers,
    orderStatus: order.status,
    fulfilment: fulfilmentStage(order),
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    lines: order.items.map((it) => ({
      name: it.name,
      qty: D(it.qty).toString(),
      unitPrice: m2(it.unitPrice),
      modifiers: it.modifiers.map((m) => ({ name: m.name, priceDelta: m2(m.priceDelta) })),
      discount: m2(it.discount),
      taxPct: D(it.taxPct).toString(),
      lineTotal: m2(it.lineTotal),
      notes: it.notes,
    })),
    subtotal: m2(order.subtotal),
    discount: m2(order.discount),
    taxes: taxBreakdown(order),
    tax: m2(order.tax),
    total: m2(order.total),
    payments: settled.map((p) => ({ method: p.method, status: p.status, amount: m2(p.amount), at: (p.verifiedAt ?? p.createdAt).toISOString() })),
    refunds: refunds.map((r) => ({ amount: m2(r.amount), at: r.createdAt.toISOString() })).sort((a, b) => a.at.localeCompare(b.at)),
    paid: m2(paid),
    refunded: m2(refunded),
    balanceDue: m2(balance.lt(0) ? 0 : balance),
    paymentStatus,
    invoice: inv && {
      number: inv.number,
      issuedAt: inv.issuedAt.toISOString(),
      supplyType: inv.supplyType,
      sellerGstin: inv.sellerGstin,
      buyerGstin: inv.buyerGstin,
      buyerName: inv.buyerName,
      placeOfSupply: inv.placeOfSupply,
      lines: inv.lines.map((l) => ({ ratePct: D(l.ratePct).toString(), hsnSac: l.hsnSac, taxable: m2(l.taxableValue), cgst: m2(l.cgst), sgst: m2(l.sgst), igst: m2(l.igst) })),
    },
    creditNotes: invoices.filter((i) => i.kind === "CREDIT_NOTE").map((c) => ({ number: c.number, issuedAt: c.issuedAt.toISOString(), total: m2(c.total), reason: c.reason })),
  };
}

export const billOrderInclude = {
  table: { select: { code: true } },
  items: { include: { modifiers: true }, orderBy: { createdAt: "asc" } },
  payments: { include: { refunds: true }, orderBy: { createdAt: "asc" } },
  kots: { select: { status: true } },
} as const;

export async function loadBillVenue(db: PrismaClient, organizationId: string, outletId: string): Promise<BillVenue> {
  const [organization, outlet] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, legalName: true } }),
    db.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { name: true, address: true, phone: true, timezone: true, currency: true } }),
  ]);
  return { organization, outlet };
}

/** Staff view of an order's bill (view / print / reprint). Same rules as getOrder. */
export async function getOrderBill(db: PrismaClient, ctx: AccessContext, orderId: string): Promise<Bill> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: billOrderInclude });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, order.outletId);
  assertCan(ctx, "order.view", order.outletId);
  return buildBill(order, await loadBillVenue(db, order.organizationId, order.outletId), await getOrderInvoices(db, order.id));
}
