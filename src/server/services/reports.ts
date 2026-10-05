/**
 * Report registry + CSV export.
 *
 * Every report is registered once in REPORTS with: id, Zod filter schema,
 * required permission, maximum row count, ordered output columns and a query.
 * Queries resolve their outlet scope through `authorizedOutletIds` (org scope +
 * outlets where the actor holds the report's permission; an explicitly
 * requested outlet the actor cannot access is rejected with 403).
 *
 * Aggregate reports reuse the existing analytics / vendor-dues / P&L services
 * (no duplicated business logic). Raw-row reports page in the database
 * (deterministic order + skip/take) and are hard-capped at `maxRows`.
 *
 * Exports require `export.run` in addition to the report's permission, create
 * an ExportJob (RUNNING -> SUCCESS/FAILED, with params/rowCount/error) and, on
 * success, an EXPORT audit entry. The CSV is returned to the caller; nothing is
 * written to disk (ExportJob.filePath stays null).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { InventoryTransactionType, OrderChannel, OrderStatus, PaymentMethod, PaymentStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan, type Permission } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { authorizedOutletIds, dailySales, itemSales, categorySales, salesTrend, outletComparison, variantSales, modifierSales, materialConsumption, stockAgeing, vendorPurchasing, purchaseTrend, SETTLED_ORDER_STATUSES } from "@/server/services/analytics";
import { vendorDues } from "@/server/services/procurement";
import { computePnL } from "@/server/services/finance";
import { segmentFor } from "@/server/services/crm";
import { toCSV, type CsvColumn } from "@/domain/csv";
import { resolveDateFilters } from "@/server/services/businessDay";
import { D, money, num } from "@/domain/money";
import { taxSummary } from "@/server/services/invoicing";
import { vendorAging } from "@/server/services/vendorFinance";

// ---------------- filters ----------------

const baseFilter = z.object({
  outletId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
const rangeOk = (f: { from?: Date; to?: Date }) => !f.from || !f.to || f.from <= f.to;
const RANGE_MSG = { message: "`from` must be on or before `to`" };

type Base = z.infer<typeof baseFilter>;
type RunArgs<F> = { db: PrismaClient; ctx: AccessContext; f: F; limit: number; offset: number };

type Column<Row> = { key: string; header: string; value: (r: Row) => unknown };

type ReportDef<F extends Base, Row> = {
  id: string;
  title: string;
  permission: Permission;
  schema: z.ZodType<F, z.ZodTypeDef, unknown>;
  /** Hard cap on rows returned/exported per request. */
  maxRows: number;
  /** true = rows are aggregates computed in the DB (the whole set is small). */
  aggregate: boolean;
  columns: Column<Row>[];
  /** Must return rows [offset, offset + limit + 1) so truncation can be detected. */
  run: (a: RunArgs<F>) => Promise<Row[]>;
};

type AnyReport = ReportDef<any, any>; // heterogeneous registry; each entry is fully typed via define()
/** Two-step so `Row` is inferred from `run` before the columns are checked against it. */
const define =
  <F extends Base, Row>(d: Omit<ReportDef<F, Row>, "columns">) =>
  (columns: Column<Row>[]): AnyReport => ({ ...d, columns });

/** Window an in-memory aggregate list the same way DB-paged reports are windowed. */
const windowed = <T>(rows: T[], a: { offset: number; limit: number }) => rows.slice(a.offset, a.offset + a.limit + 1);
const dateRange = (f: Base) => (f.from || f.to ? { gte: f.from, lte: f.to } : undefined);

async function outletCodes(db: PrismaClient, ctx: AccessContext, ids: string[]) {
  const rows = await db.outlet.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, code: true } });
  return new Map(rows.map((o) => [o.id, o.code]));
}

async function materialInfo(db: PrismaClient, ctx: AccessContext, ids: string[]) {
  const rows = await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(ids)] } }, select: { id: true, sku: true, name: true, reorderLevel: true, baseUnit: { select: { code: true } } } });
  return new Map(rows.map((m) => [m.id, m]));
}

/** Customers visible for customer/loyalty reports: org-wide actors see all; others only customers who ordered at their authorized outlets. */
function customerScope(ctx: AccessContext, ids: string[], explicitOutlet: boolean) {
  if ((ctx.isOrgWide || ctx.isSuperAdmin) && !explicitOutlet) return { organizationId: ctx.organizationId };
  return { organizationId: ctx.organizationId, orders: { some: { outletId: { in: ids } } } };
}

const WASTE_TYPES = ["WASTAGE", "SPOILAGE", "STAFF_MEAL"];
const FINANCE_ENTITY_TYPES = ["Payment", "Refund", "TaxInvoice", "Expense", "ExpenseCategory", "PettyCashTxn", "CashDrawerSession", "CashDrawerMovement", "VendorPayment", "PurchaseBill", "Reconciliation", "Order"];

// ---------------- registry ----------------

export const REPORTS: Record<string, AnyReport> = {
  DAILY_SALES: define({
    id: "DAILY_SALES", title: "Daily sales", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.extend({ utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).optional() }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => {
      const rows = await dailySales(db, ctx, f);
      const codes = await outletCodes(db, ctx, [...new Set(rows.map((r) => r.outletId))]);
      return windowed(rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) ?? r.outletId })), w);
    },
  })([
      { key: "day", header: "Day", value: (r) => r.day }, { key: "outlet", header: "Outlet", value: (r) => r.outlet },
      { key: "orders", header: "Orders", value: (r) => r.orders }, { key: "covers", header: "Covers", value: (r) => r.covers },
      { key: "grossSales", header: "Gross sales", value: (r) => r.grossSales }, { key: "discounts", header: "Discounts", value: (r) => r.discounts },
      { key: "taxes", header: "Taxes", value: (r) => r.taxes }, { key: "total", header: "Total", value: (r) => r.total },
      { key: "refunds", header: "Refunds", value: (r) => r.refunds }, { key: "netSales", header: "Net sales (ex tax)", value: (r) => r.netSales },
    ]),

  ITEM_SALES: define({
    id: "ITEM_SALES", title: "Item sales", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await itemSales(db, ctx, f), w),
  })([
      { key: "item", header: "Item", value: (r) => r.name }, { key: "menuItemId", header: "Menu item id", value: (r) => r.menuItemId ?? "UNMAPPED" },
      { key: "qty", header: "Qty", value: (r) => r.qty }, { key: "grossRevenue", header: "Gross revenue", value: (r) => r.grossRevenue },
      { key: "discount", header: "Discount", value: (r) => r.discount }, { key: "refundedQty", header: "Refunded qty", value: (r) => r.refundedQty },
      { key: "refundedRevenue", header: "Refunded revenue", value: (r) => r.refundedRevenue }, { key: "revenue", header: "Net revenue", value: (r) => r.revenue },
      { key: "contributionPct", header: "Share %", value: (r) => r.contributionPct },
    ]),

  CATEGORY_SALES: define({
    id: "CATEGORY_SALES", title: "Category sales", permission: "reports.view", maxRows: 1000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await categorySales(db, ctx, f), w),
  })([
      { key: "category", header: "Category", value: (r) => r.category }, { key: "items", header: "Items", value: (r) => r.items }, { key: "qty", header: "Qty", value: (r) => r.qty },
      { key: "grossRevenue", header: "Gross revenue", value: (r) => r.grossRevenue }, { key: "discount", header: "Discount", value: (r) => r.discount },
      { key: "refundedRevenue", header: "Refunded revenue", value: (r) => r.refundedRevenue }, { key: "revenue", header: "Net revenue", value: (r) => r.revenue },
      { key: "contributionPct", header: "Share %", value: (r) => r.contributionPct },
    ]),

  SALES_TREND: define({
    id: "SALES_TREND", title: "Sales trend (day / week / month)", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.extend({ granularity: z.enum(["day", "week", "month"]).default("day") }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await salesTrend(db, ctx, f), w),
  })([
      { key: "period", header: "Period", value: (r) => r.period }, { key: "orders", header: "Orders", value: (r) => r.orders },
      { key: "grossSales", header: "Gross sales", value: (r) => r.grossSales }, { key: "discounts", header: "Discounts", value: (r) => r.discounts },
      { key: "refunds", header: "Refunds", value: (r) => r.refunds }, { key: "netSales", header: "Net sales (ex tax)", value: (r) => r.netSales },
      { key: "taxes", header: "Taxes", value: (r) => r.taxes }, { key: "total", header: "Billed total", value: (r) => r.total }, { key: "aov", header: "AOV", value: (r) => r.aov },
    ]),

  OUTLET_COMPARISON: define({
    id: "OUTLET_COMPARISON", title: "Outlet comparison", permission: "reports.view", maxRows: 1000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await outletComparison(db, ctx, f), w),
  })([
      { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "orders", header: "Orders", value: (r) => r.orders }, { key: "refundedOrders", header: "Refunded orders", value: (r) => r.refundedOrders },
      { key: "grossSales", header: "Gross sales", value: (r) => r.grossSales }, { key: "discounts", header: "Discounts", value: (r) => r.discounts },
      { key: "refunds", header: "Refunds", value: (r) => r.refunds }, { key: "netSales", header: "Net sales (ex tax)", value: (r) => r.netSales },
      { key: "aov", header: "AOV", value: (r) => r.aov }, { key: "sharePct", header: "Share %", value: (r) => r.sharePct },
    ]),

  VARIANT_SALES: define({
    id: "VARIANT_SALES", title: "Variant sales", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await variantSales(db, ctx, f), w),
  })([
      { key: "item", header: "Item", value: (r) => r.item }, { key: "variant", header: "Variant", value: (r) => r.variant }, { key: "qty", header: "Qty", value: (r) => r.qty },
      { key: "grossRevenue", header: "Gross revenue", value: (r) => r.grossRevenue }, { key: "discount", header: "Discount", value: (r) => r.discount },
      { key: "revenue", header: "Net revenue", value: (r) => r.revenue }, { key: "contributionPct", header: "Share %", value: (r) => r.contributionPct },
    ]),

  MODIFIER_SALES: define({
    id: "MODIFIER_SALES", title: "Modifier / add-on sales", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await modifierSales(db, ctx, f), w),
  })([
      { key: "modifier", header: "Modifier", value: (r) => r.modifier }, { key: "lines", header: "Lines", value: (r) => r.lines },
      { key: "qty", header: "Qty", value: (r) => r.qty }, { key: "addOnValue", header: "Add-on value", value: (r) => r.addOnValue },
    ]),

  MATERIAL_CONSUMPTION: define({
    id: "MATERIAL_CONSUMPTION", title: "Material consumption & wastage", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await materialConsumption(db, ctx, f), w),
  })([
      { key: "material", header: "Material", value: (r) => r.material }, { key: "unit", header: "Unit", value: (r) => r.unit },
      { key: "saleQty", header: "Sold (qty)", value: (r) => r.saleQty }, { key: "productionQty", header: "Production (qty)", value: (r) => r.productionQty },
      { key: "issueQty", header: "Issued (qty)", value: (r) => r.issueQty }, { key: "wastageQty", header: "Wasted (qty)", value: (r) => r.wastageQty },
      { key: "consumedValue", header: "Consumed value", value: (r) => r.consumedValue }, { key: "wastageValue", header: "Wastage value", value: (r) => r.wastageValue },
      { key: "wastagePct", header: "Wastage %", value: (r) => r.wastagePct },
    ]),

  STOCK_AGEING: define({
    id: "STOCK_AGEING", title: "Slow-moving & dead stock", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.extend({ lookbackDays: z.coerce.number().int().min(1).max(365).optional() }),
    // Point in time (now); `lookbackDays` sets the usage window.
    run: async ({ db, ctx, f, ...w }) => windowed(await stockAgeing(db, ctx, { outletId: f.outletId, lookbackDays: f.lookbackDays }), w),
  })([
      { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "material", header: "Material", value: (r) => r.material }, { key: "unit", header: "Unit", value: (r) => r.unit },
      { key: "status", header: "Status", value: (r) => r.status }, { key: "onHand", header: "On hand", value: (r) => r.onHand }, { key: "value", header: "Stock value", value: (r) => r.value },
      { key: "usedQty", header: "Used in window (qty)", value: (r) => r.usedQty }, { key: "daysOfCover", header: "Days of cover", value: (r) => r.daysOfCover },
      { key: "lastUsedAt", header: "Last used", value: (r) => r.lastUsedAt },
    ]),

  PURCHASE_TREND: define({
    id: "PURCHASE_TREND", title: "Purchase trend", permission: "reports.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.extend({ granularity: z.enum(["day", "week", "month"]).default("month") }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await purchaseTrend(db, ctx, f), w),
  })([{ key: "period", header: "Period", value: (r) => r.period }, { key: "receipts", header: "Receipt lines", value: (r) => r.receipts }, { key: "value", header: "Received value", value: (r) => r.value }]),

  VENDOR_PURCHASING: define({
    id: "VENDOR_PURCHASING", title: "Vendor purchasing", permission: "purchase.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await vendorPurchasing(db, ctx, f), w),
  })([
      { key: "vendor", header: "Vendor", value: (r) => r.vendor }, { key: "receipts", header: "GRNs", value: (r) => r.receipts }, { key: "receivedValue", header: "Received value", value: (r) => r.receivedValue },
      { key: "bills", header: "Bills", value: (r) => r.bills }, { key: "billedTotal", header: "Billed total", value: (r) => r.billedTotal }, { key: "billedTax", header: "Bill tax", value: (r) => r.billedTax },
      { key: "paidOnBills", header: "Paid", value: (r) => r.paidOnBills }, { key: "dueOnBills", header: "Due", value: (r) => r.dueOnBills },
    ]),

  ORDERS: define({
    id: "ORDERS", title: "Orders (sales)", permission: "reports.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.extend({ status: OrderStatus.zod.optional(), channel: OrderChannel.zod.optional() }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId });
      if (!ids.length) return [];
      const rows = await db.order.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}), ...(f.status ? { status: f.status } : {}), ...(f.channel ? { channel: f.channel } : {}) },
        include: { table: { select: { code: true } }, customer: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "orderId", header: "Order", value: (r) => r.id },
      { key: "invoiceNo", header: "Invoice", value: (r) => r.invoiceNo }, { key: "channel", header: "Channel", value: (r) => r.channel }, { key: "source", header: "Source", value: (r) => r.source },
      { key: "status", header: "Status", value: (r) => r.status }, { key: "table", header: "Table", value: (r) => r.table?.code }, { key: "customer", header: "Customer", value: (r) => r.customer?.name },
      { key: "covers", header: "Covers", value: (r) => r.covers }, { key: "subtotal", header: "Subtotal", value: (r) => num(r.subtotal) }, { key: "discount", header: "Discount", value: (r) => num(r.discount) },
      { key: "tax", header: "Tax", value: (r) => num(r.tax) }, { key: "total", header: "Total", value: (r) => num(r.total) }, { key: "paidAt", header: "Paid", value: (r) => r.paidAt },
    ]),

  INVENTORY: define({
    id: "INVENTORY", title: "Inventory on hand", permission: "inventory.view", maxRows: 10000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG), // `to` = as-of date for historical stock
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "inventory.view");
      if (!ids.length) return [];
      const grouped = await db.inventoryLedger.groupBy({
        by: ["outletId", "materialId"],
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.to ? { createdAt: { lte: f.to } } : {}) },
        _sum: { qty: true },
        having: { qty: { _sum: { not: 0 } } },
        orderBy: [{ outletId: "asc" }, { materialId: "asc" }],
        skip: offset,
        take: limit + 1,
      });
      const [codes, mats, costs] = await Promise.all([
        outletCodes(db, ctx, ids),
        materialInfo(db, ctx, grouped.map((g) => g.materialId)),
        db.outletMaterialCost.findMany({ where: { organizationId: ctx.organizationId, outletId: { in: ids }, materialId: { in: grouped.map((g) => g.materialId) } } }),
      ]);
      const cost = new Map(costs.map((c) => [`${c.outletId}:${c.materialId}`, D(c.avgCost)]));
      return grouped.map((g) => {
        const q = D(g._sum.qty ?? 0);
        const avg = cost.get(`${g.outletId}:${g.materialId}`) ?? D(0);
        const m = mats.get(g.materialId);
        const reorder = D(m?.reorderLevel ?? 0);
        return { outlet: codes.get(g.outletId), sku: m?.sku, material: m?.name, unit: m?.baseUnit.code, qty: num(q), avgCost: num(avg), value: num(money(q.times(avg))), reorderLevel: num(reorder), belowReorder: reorder.gt(0) && q.lte(reorder) };
      });
    },
  })([
      { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "sku", header: "SKU", value: (r) => r.sku }, { key: "material", header: "Material", value: (r) => r.material },
      { key: "unit", header: "Unit", value: (r) => r.unit }, { key: "qty", header: "Qty on hand", value: (r) => r.qty }, { key: "avgCost", header: "Avg cost", value: (r) => r.avgCost },
      { key: "value", header: "Value (at current avg cost)", value: (r) => r.value }, { key: "reorderLevel", header: "Reorder level", value: (r) => r.reorderLevel },
      { key: "belowReorder", header: "Below reorder", value: (r) => r.belowReorder },
    ]),

  STOCK_MOVEMENT: define({
    id: "STOCK_MOVEMENT", title: "Stock movement", permission: "inventory.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.extend({ materialId: z.string().optional(), txnType: InventoryTransactionType.zod.optional() }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "inventory.view");
      if (!ids.length) return [];
      const rows = await db.inventoryLedger.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}), ...(f.materialId ? { materialId: f.materialId } : {}), ...(f.txnType ? { txnType: f.txnType } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
        include: { material: { select: { sku: true, name: true } } },
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "sku", header: "SKU", value: (r) => r.material.sku },
      { key: "material", header: "Material", value: (r) => r.material.name }, { key: "txnType", header: "Type", value: (r) => r.txnType }, { key: "qty", header: "Qty", value: (r) => num(r.qty) },
      { key: "rate", header: "Rate", value: (r) => num(r.rate) }, { key: "amount", header: "Amount", value: (r) => num(r.amount) }, { key: "sourceType", header: "Source", value: (r) => r.sourceType },
      { key: "sourceId", header: "Source id", value: (r) => r.sourceId }, { key: "note", header: "Note", value: (r) => r.note },
    ]),

  PURCHASES: define({
    id: "PURCHASES", title: "Purchases (posted GRNs)", permission: "purchase.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.extend({ vendorId: z.string().optional() }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "purchase.view");
      if (!ids.length) return [];
      const rows = await db.goodsReceiptLine.findMany({
        where: { organizationId: ctx.organizationId, grn: { status: "POSTED", outletId: { in: ids }, ...(dateRange(f) ? { receivedAt: dateRange(f) } : {}), ...(f.vendorId ? { vendorId: f.vendorId } : {}) } },
        orderBy: [{ grn: { receivedAt: "asc" } }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
        include: { grn: { select: { number: true, receivedAt: true, outletId: true, vendorId: true, po: { select: { number: true } } } } },
      });
      const [codes, mats, vendors] = await Promise.all([
        outletCodes(db, ctx, ids),
        materialInfo(db, ctx, rows.map((r) => r.materialId)),
        db.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(rows.map((r) => r.grn.vendorId))] } }, select: { id: true, name: true } }),
      ]);
      const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
      return rows.map((r) => ({ ...r, outlet: codes.get(r.grn.outletId), vendor: vendorName.get(r.grn.vendorId), sku: mats.get(r.materialId)?.sku, material: mats.get(r.materialId)?.name }));
    },
  })([
      { key: "date", header: "Received", value: (r) => r.grn.receivedAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "grn", header: "GRN", value: (r) => r.grn.number },
      { key: "po", header: "PO", value: (r) => r.grn.po?.number }, { key: "vendor", header: "Vendor", value: (r) => r.vendor }, { key: "sku", header: "SKU", value: (r) => r.sku },
      { key: "material", header: "Material", value: (r) => r.material }, { key: "qty", header: "Qty", value: (r) => num(r.qty) }, { key: "damagedQty", header: "Damaged", value: (r) => num(r.damagedQty) },
      { key: "rate", header: "Rate", value: (r) => num(r.rate) }, { key: "value", header: "Value", value: (r) => num(money(D(r.qty).times(D(r.rate)))) },
    ]),

  VENDOR_DUES: define({
    id: "VENDOR_DUES", title: "Vendor dues", permission: "finance.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.extend({ vendorId: z.string().optional() }).refine(rangeOk, RANGE_MSG), // `to` = as-of date for overdue
    run: async ({ db, ctx, f, ...w }) => windowed(await vendorDues(db, ctx, { outletId: f.outletId, vendorId: f.vendorId, asOf: f.to }), w),
  })([
      { key: "vendor", header: "Vendor", value: (r) => r.vendorName }, { key: "openBills", header: "Open bills", value: (r) => r.openBills }, { key: "billed", header: "Billed", value: (r) => r.billed },
      { key: "paid", header: "Paid", value: (r) => r.paid }, { key: "due", header: "Due", value: (r) => r.due }, { key: "overdue", header: "Overdue", value: (r) => r.overdue },
    ]),

  WASTAGE: define({
    id: "WASTAGE", title: "Wastage", permission: "inventory.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    // From the ledger (the cost truth), enriched with the wastage document where one exists.
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "inventory.view");
      if (!ids.length) return [];
      const rows = await db.inventoryLedger.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, txnType: { in: WASTE_TYPES }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
        include: { material: { select: { sku: true, name: true } } },
      });
      const docIds = [...new Set(rows.filter((r) => r.sourceType === "WASTAGE" && r.sourceId).map((r) => r.sourceId!))];
      const [codes, docs] = await Promise.all([outletCodes(db, ctx, ids), db.wastage.findMany({ where: { organizationId: ctx.organizationId, id: { in: docIds } }, select: { id: true, number: true, reason: true } })]);
      const doc = new Map(docs.map((d) => [d.id, d]));
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId), docNumber: r.sourceId ? doc.get(r.sourceId)?.number : undefined, reason: r.sourceId ? doc.get(r.sourceId)?.reason ?? r.note : r.note }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "document", header: "Document", value: (r) => r.docNumber },
      { key: "reason", header: "Reason", value: (r) => r.reason }, { key: "txnType", header: "Type", value: (r) => r.txnType }, { key: "sku", header: "SKU", value: (r) => r.material.sku },
      { key: "material", header: "Material", value: (r) => r.material.name }, { key: "qty", header: "Qty", value: (r) => num(D(r.qty).abs()) }, { key: "cost", header: "Cost impact", value: (r) => num(D(r.amount).abs()) },
    ]),

  STOCK_COUNT_VARIANCE: define({
    id: "STOCK_COUNT_VARIANCE", title: "Stock count variance (physical vs system)", permission: "inventory.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    // Approved counts only (their variance was posted as COUNT_ADJUSTMENT); dated by approval.
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "inventory.view");
      if (!ids.length) return [];
      const rows = await db.stockCountLine.findMany({
        where: { organizationId: ctx.organizationId, count: { status: "APPROVED", outletId: { in: ids }, ...(dateRange(f) ? { approvedAt: dateRange(f) } : {}) } },
        orderBy: [{ count: { approvedAt: "asc" } }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
        include: { count: { select: { number: true, outletId: true, approvedAt: true } } },
      });
      const materials = await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(rows.map((r) => r.materialId))] } }, select: { id: true, sku: true, name: true, baseUnit: { select: { code: true } } } });
      const m = new Map(materials.map((x) => [x.id, x]));
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.count.outletId), material: m.get(r.materialId) }));
    },
  })([
      { key: "approved", header: "Approved", value: (r) => r.count.approvedAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "count", header: "Count", value: (r) => r.count.number },
      { key: "sku", header: "SKU", value: (r) => r.material?.sku }, { key: "material", header: "Material", value: (r) => r.material?.name }, { key: "unit", header: "Unit", value: (r) => r.material?.baseUnit.code },
      { key: "book", header: "System qty", value: (r) => num(r.bookQty) }, { key: "physical", header: "Physical qty", value: (r) => num(r.physicalQty) },
      { key: "variance", header: "Variance", value: (r) => num(r.variance) }, { key: "costImpact", header: "Cost impact", value: (r) => num(r.costImpact) },
    ]),

  STOCK_ADJUSTMENTS: define({
    id: "STOCK_ADJUSTMENTS", title: "Stock adjustments", permission: "inventory.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    // Manual adjustments (reason in the note), count adjustments, opening stock and corrections.
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "inventory.view");
      if (!ids.length) return [];
      const rows = await db.inventoryLedger.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, txnType: { in: ["OTHER_ADJUSTMENT", "COUNT_ADJUSTMENT", "OPENING_BALANCE"] }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
        include: { material: { select: { sku: true, name: true } } },
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "txnType", header: "Type", value: (r) => r.txnType },
      { key: "sku", header: "SKU", value: (r) => r.material.sku }, { key: "material", header: "Material", value: (r) => r.material.name }, { key: "qty", header: "Qty", value: (r) => num(r.qty) },
      { key: "value", header: "Value", value: (r) => num(r.amount) }, { key: "reason", header: "Reason / note", value: (r) => r.note }, { key: "actor", header: "By", value: (r) => r.actorId },
    ]),

  PAYMENTS: define({
    id: "PAYMENTS", title: "Payments", permission: "finance.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.extend({ status: PaymentStatus.zod.optional(), method: PaymentMethod.zod.optional() }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const rows = await db.payment.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}), ...(f.status ? { status: f.status } : {}), ...(f.method ? { method: f.method } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "orderId", header: "Order", value: (r) => r.orderId },
      { key: "method", header: "Method", value: (r) => r.method }, { key: "status", header: "Status", value: (r) => r.status }, { key: "amount", header: "Amount", value: (r) => num(r.amount) },
      { key: "provider", header: "Provider", value: (r) => r.provider }, { key: "providerRef", header: "Provider ref", value: (r) => r.providerRef }, { key: "verifiedAt", header: "Verified", value: (r) => r.verifiedAt },
    ]),

  REFUNDS: define({
    id: "REFUNDS", title: "Refunds", permission: "finance.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const rows = await db.refund.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
        include: { payment: { select: { orderId: true, method: true } } },
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "orderId", header: "Order", value: (r) => r.payment.orderId },
      { key: "paymentId", header: "Payment", value: (r) => r.paymentId }, { key: "method", header: "Method", value: (r) => r.payment.method }, { key: "amount", header: "Amount", value: (r) => num(r.amount) },
      { key: "reason", header: "Reason", value: (r) => r.reason },
    ]),

  EXPENSES: define({
    id: "EXPENSES", title: "Expenses", permission: "finance.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.extend({ category: z.string().optional() }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const rows = await db.expense.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, voidedAt: null, ...(dateRange(f) ? { spentAt: dateRange(f) } : {}), ...(f.category ? { category: f.category } : {}) },
        orderBy: [{ spentAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit + 1,
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.spentAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "category", header: "Category", value: (r) => r.category },
      { key: "amount", header: "Amount", value: (r) => num(r.amount) }, { key: "paidVia", header: "Paid via", value: (r) => r.paidVia }, { key: "description", header: "Description", value: (r) => r.description },
    ]),

  // ---------------- Phase 4 finance ----------------

  TAX_SUMMARY: define({
    id: "TAX_SUMMARY", title: "Tax summary (invoices and credit notes by rate)", permission: "finance.view", maxRows: 1000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await taxSummary(db, ctx, { outletIds: authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view"), from: f.from, to: f.to }), w),
  })([
      { key: "kind", header: "Document", value: (r) => r.kind }, { key: "rate", header: "Rate %", value: (r) => r.ratePct }, { key: "documents", header: "Documents", value: (r) => r.documents },
      { key: "taxable", header: "Taxable value", value: (r) => r.taxableValue }, { key: "cgst", header: "CGST", value: (r) => r.cgst }, { key: "sgst", header: "SGST", value: (r) => r.sgst },
      { key: "igst", header: "IGST", value: (r) => r.igst }, { key: "totalTax", header: "Total tax", value: (r) => r.totalTax },
    ]),

  INVOICES: define({
    id: "INVOICES", title: "Invoice register", permission: "finance.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const rows = await db.taxInvoice.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(dateRange(f) ? { issuedAt: dateRange(f) } : {}) },
        orderBy: [{ issuedAt: "asc" }, { seq: "asc" }, { id: "asc" }], skip: offset, take: limit + 1,
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Issued", value: (r) => r.issuedAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "number", header: "Number", value: (r) => r.number },
      { key: "kind", header: "Document", value: (r) => r.kind }, { key: "orderId", header: "Order", value: (r) => r.orderId }, { key: "sellerGstin", header: "Seller GSTIN", value: (r) => r.sellerGstin },
      { key: "buyerGstin", header: "Buyer GSTIN", value: (r) => r.buyerGstin }, { key: "supplyType", header: "Supply", value: (r) => r.supplyType },
      { key: "taxable", header: "Taxable value", value: (r) => num(r.taxableValue) }, { key: "cgst", header: "CGST", value: (r) => num(r.cgst) }, { key: "sgst", header: "SGST", value: (r) => num(r.sgst) },
      { key: "igst", header: "IGST", value: (r) => num(r.igst) }, { key: "total", header: "Total", value: (r) => num(r.total) },
    ]),

  SALES_VS_PAYMENTS: define({
    id: "SALES_VS_PAYMENTS", title: "Sales vs payments", permission: "finance.view", maxRows: 1000, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    // Per outlet for the period: settled sales (PAID + REFUNDED orders) against money collected and refunded.
    run: async ({ db, ctx, f, ...w }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const at = dateRange(f);
      const [sales, collected, refunds, codes] = await Promise.all([
        db.order.groupBy({ by: ["outletId"], where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: { in: SETTLED_ORDER_STATUSES }, ...(at ? { createdAt: at } : {}) }, _sum: { total: true }, _count: true }),
        db.payment.groupBy({ by: ["outletId"], where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: { in: ["SUCCESS", "PARTIAL", "REFUNDED"] }, ...(at ? { createdAt: at } : {}) }, _sum: { amount: true } }),
        db.refund.groupBy({ by: ["outletId"], where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(at ? { createdAt: at } : {}) }, _sum: { amount: true } }),
        outletCodes(db, ctx, ids),
      ]);
      const rows = ids.map((id) => {
        const s = D(sales.find((x) => x.outletId === id)?._sum.total ?? 0);
        const c = D(collected.find((x) => x.outletId === id)?._sum.amount ?? 0);
        const r = D(refunds.find((x) => x.outletId === id)?._sum.amount ?? 0);
        return { outlet: codes.get(id), orders: sales.find((x) => x.outletId === id)?._count ?? 0, sales: num(money(s)), collected: num(money(c)), refunded: num(money(r)), netCollected: num(money(c.minus(r))), difference: num(money(c.minus(s))) };
      });
      return windowed(rows, w);
    },
  })([
      { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "orders", header: "Settled orders", value: (r) => r.orders }, { key: "sales", header: "Sales", value: (r) => r.sales },
      { key: "collected", header: "Collected", value: (r) => r.collected }, { key: "refunded", header: "Refunded", value: (r) => r.refunded }, { key: "netCollected", header: "Net collected", value: (r) => r.netCollected },
      { key: "difference", header: "Collected − sales", value: (r) => r.difference },
    ]),

  CASH_DRAWER: define({
    id: "CASH_DRAWER", title: "Cash drawer sessions", permission: "finance.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const rows = await db.cashDrawerSession.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(dateRange(f) ? { openedAt: dateRange(f) } : {}) },
        orderBy: [{ openedAt: "asc" }, { id: "asc" }], skip: offset, take: limit + 1,
        include: { movements: { select: { type: true, amount: true } } },
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({
        ...r, outlet: codes.get(r.outletId),
        payIn: num(money(r.movements.filter((m) => m.type === "PAY_IN").reduce((a, m) => a.plus(D(m.amount)), D(0)))),
        payOut: num(money(r.movements.filter((m) => m.type === "PAY_OUT").reduce((a, m) => a.plus(D(m.amount)), D(0)))),
      }));
    },
  })([
      { key: "opened", header: "Opened", value: (r) => r.openedAt }, { key: "closed", header: "Closed", value: (r) => r.closedAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet },
      { key: "status", header: "Status", value: (r) => r.status }, { key: "float", header: "Opening float", value: (r) => num(r.openingFloat) }, { key: "payIn", header: "Pay-ins", value: (r) => r.payIn },
      { key: "payOut", header: "Pay-outs", value: (r) => r.payOut }, { key: "expected", header: "Expected cash", value: (r) => (r.expectedCash === null ? null : num(r.expectedCash)) },
      { key: "counted", header: "Counted", value: (r) => (r.closingCount === null ? null : num(r.closingCount)) }, { key: "variance", header: "Variance", value: (r) => (r.variance === null ? null : num(r.variance)) },
    ]),

  VENDOR_AGING: define({
    id: "VENDOR_AGING", title: "Vendor payables aging", permission: "finance.view", maxRows: 5000, aggregate: true,
    schema: baseFilter.extend({ vendorId: z.string().optional() }).refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => windowed(await vendorAging(db, ctx, { outletId: f.outletId, vendorId: f.vendorId, asOf: f.to }), w),
  })([
      { key: "vendor", header: "Vendor", value: (r) => r.vendorName }, { key: "openBills", header: "Open bills", value: (r) => r.openBills }, { key: "current", header: "Not yet due", value: (r) => r.current },
      { key: "d1_30", header: "1–30 days", value: (r) => r.d1_30 }, { key: "d31_60", header: "31–60 days", value: (r) => r.d31_60 }, { key: "d61_90", header: "61–90 days", value: (r) => r.d61_90 },
      { key: "d90_plus", header: "90+ days", value: (r) => r.d90_plus }, { key: "totalDue", header: "Total due", value: (r) => r.totalDue }, { key: "advances", header: "Advances", value: (r) => r.advances },
      { key: "netPayable", header: "Net payable", value: (r) => r.netPayable },
    ]),

  OUTSTANDING_ORDERS: define({
    id: "OUTSTANDING_ORDERS", title: "Outstanding order balances", permission: "finance.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    // Live orders with a balance still to collect (total − SUCCESS/PARTIAL payments).
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const rows = await db.order.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] }, total: { gt: 0 }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: offset, take: limit + 1,
        include: { payments: { where: { status: { in: ["SUCCESS", "PARTIAL"] } }, select: { amount: true } }, table: { select: { code: true } } },
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => {
        const paid = r.payments.reduce((a, p) => a.plus(D(p.amount)), D(0));
        return { ...r, outlet: codes.get(r.outletId), paid: num(money(paid)), balance: num(money(D(r.total).minus(paid))) };
      });
    },
  })([
      { key: "date", header: "Created", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "orderId", header: "Order", value: (r) => r.id },
      { key: "status", header: "Status", value: (r) => r.status }, { key: "table", header: "Table", value: (r) => r.table?.code }, { key: "total", header: "Total", value: (r) => num(r.total) },
      { key: "paid", header: "Paid", value: (r) => r.paid }, { key: "balance", header: "Balance", value: (r) => r.balance },
    ]),

  DISCOUNTS: define({
    id: "DISCOUNTS", title: "Discounts on paid orders", permission: "finance.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
      if (!ids.length) return [];
      const rows = await db.order.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: { in: ["PAID", "REFUNDED"] }, discount: { gt: 0 }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: offset, take: limit + 1,
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: codes.get(r.outletId) }));
    },
  })([
      { key: "date", header: "Date", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "orderId", header: "Order", value: (r) => r.id },
      { key: "invoiceNo", header: "Invoice", value: (r) => r.invoiceNo }, { key: "subtotal", header: "Subtotal", value: (r) => num(r.subtotal) }, { key: "discount", header: "Discount", value: (r) => num(r.discount) },
      { key: "tax", header: "Tax", value: (r) => num(r.tax) }, { key: "total", header: "Total", value: (r) => num(r.total) },
    ]),

  FINANCE_AUDIT: define({
    id: "FINANCE_AUDIT", title: "Financial audit trail", permission: "audit.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    // Every money-changing event: payments, refunds, invoices, expenses, cash, vendor payables, reconciliations.
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "audit.view");
      if (!ids.length) return [];
      const rows = await db.auditLog.findMany({
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, entityType: { in: FINANCE_ENTITY_TYPES }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: offset, take: limit + 1,
      });
      const codes = await outletCodes(db, ctx, ids);
      return rows.map((r) => ({ ...r, outlet: r.outletId ? codes.get(r.outletId) : undefined }));
    },
  })([
      { key: "date", header: "When", value: (r) => r.createdAt }, { key: "outlet", header: "Outlet", value: (r) => r.outlet }, { key: "actor", header: "By", value: (r) => r.actorId },
      { key: "action", header: "Action", value: (r) => r.action }, { key: "entity", header: "Entity", value: (r) => r.entityType }, { key: "entityId", header: "Entity id", value: (r) => r.entityId },
      { key: "before", header: "Before", value: (r) => r.before }, { key: "after", header: "After", value: (r) => r.after },
    ]),

  CUSTOMERS: define({
    id: "CUSTOMERS", title: "Customers", permission: "customer.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG), // from/to = activity window for order stats
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "customer.view");
      if (!ids.length) return [];
      const customers = await db.customer.findMany({ where: customerScope(ctx, ids, Boolean(f.outletId)), orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: offset, take: limit + 1 });
      const stats = await db.order.groupBy({
        by: ["customerId"],
        where: { organizationId: ctx.organizationId, outletId: { in: ids }, status: "PAID", customerId: { in: customers.map((c) => c.id) }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) },
        _count: true, _sum: { total: true }, _max: { createdAt: true },
      });
      const byId = new Map(stats.map((s) => [s.customerId, s]));
      return customers.map((c) => {
        const s = byId.get(c.id);
        const orders = s?._count ?? 0;
        const spend = num(money(D(s?._sum.total ?? 0)));
        const last = s?._max.createdAt ?? null;
        return { ...c, orders, spend, lastOrderAt: last, segment: segmentFor(orders, spend, last) };
      });
    },
  })([
      { key: "name", header: "Name", value: (r) => r.name }, { key: "phone", header: "Phone", value: (r) => r.phone }, { key: "email", header: "Email", value: (r) => r.email },
      { key: "since", header: "Customer since", value: (r) => r.createdAt }, { key: "orders", header: "Paid orders", value: (r) => r.orders }, { key: "spend", header: "Spend", value: (r) => r.spend },
      { key: "lastOrderAt", header: "Last order", value: (r) => r.lastOrderAt }, { key: "segment", header: "Segment", value: (r) => r.segment },
    ]),

  LOYALTY: define({
    id: "LOYALTY", title: "Loyalty", permission: "customer.view", maxRows: 10000, aggregate: false,
    schema: baseFilter.refine(rangeOk, RANGE_MSG), // from/to = window for earned/redeemed; balance is all-time
    run: async ({ db, ctx, f, limit, offset }) => {
      const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "customer.view");
      if (!ids.length) return [];
      const accounts = await db.loyaltyAccount.findMany({
        where: { organizationId: ctx.organizationId, customer: customerScope(ctx, ids, Boolean(f.outletId)) },
        orderBy: [{ customerId: "asc" }],
        skip: offset,
        take: limit + 1,
        include: { customer: { select: { name: true, phone: true } } },
      });
      const customerIds = accounts.map((a) => a.customerId);
      const [allTime, windowSums] = await Promise.all([
        db.loyaltyTransaction.groupBy({ by: ["customerId"], where: { organizationId: ctx.organizationId, customerId: { in: customerIds } }, _sum: { points: true } }),
        db.loyaltyTransaction.groupBy({ by: ["customerId", "type"], where: { organizationId: ctx.organizationId, customerId: { in: customerIds }, ...(dateRange(f) ? { createdAt: dateRange(f) } : {}) }, _sum: { points: true } }),
      ]);
      const balance = new Map(allTime.map((g) => [g.customerId, g._sum.points ?? 0]));
      const sum = (cid: string, type: string) => windowSums.find((g) => g.customerId === cid && g.type === type)?._sum.points ?? 0;
      return accounts.map((a) => ({ ...a, balance: balance.get(a.customerId) ?? 0, earned: sum(a.customerId, "EARN"), redeemed: -sum(a.customerId, "REDEEM") || 0, expired: -sum(a.customerId, "EXPIRE") || 0, adjusted: sum(a.customerId, "ADJUST") }));
    },
  })([
      { key: "customer", header: "Customer", value: (r) => r.customer.name }, { key: "phone", header: "Phone", value: (r) => r.customer.phone }, { key: "tier", header: "Tier", value: (r) => r.tier },
      { key: "balance", header: "Balance", value: (r) => r.balance }, { key: "earned", header: "Earned", value: (r) => r.earned }, { key: "redeemed", header: "Redeemed", value: (r) => r.redeemed },
      { key: "expired", header: "Expired", value: (r) => r.expired }, { key: "adjusted", header: "Adjusted", value: (r) => r.adjusted },
    ]),

  PNL: define({
    id: "PNL", title: "Profit & loss", permission: "finance.view", maxRows: 100, aggregate: true,
    schema: baseFilter.refine(rangeOk, RANGE_MSG),
    run: async ({ db, ctx, f, ...w }) => {
      const p = await computePnL(db, ctx, { outletId: f.outletId, from: f.from, to: f.to });
      const order: Array<keyof typeof p> = ["grossSales", "discounts", "refunds", "netSales", "taxes", "revenue", "theoreticalFoodCost", "grossMargin", "marginPct", "wastage", "countVariance", "expenses", "netProfit", "purchases"];
      const rows: Array<{ metric: string; value: number }> = order.map((k) => ({ metric: k, value: p[k] as number }));
      for (const pm of p.payments) rows.push({ metric: `payments.${pm.method}`, value: pm.amount });
      return windowed(rows, w);
    },
  })([{ key: "metric", header: "Metric", value: (r) => r.metric }, { key: "value", header: "Value", value: (r) => r.value }]),
};

export const REPORT_IDS = Object.keys(REPORTS);

export type ReportResult = {
  report: string;
  title: string;
  columns: Array<{ key: string; header: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  offset: number;
  nextOffset: number | null;
};

function cell(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") return Number(v);
  return v ?? null;
}

/** Date-only from/to = whole business days in the outlet's (or org's) timezone. */
export async function normalizeDates(db: PrismaClient, ctx: AccessContext, input: unknown) {
  if (!input || typeof input !== "object") return input ?? {};
  const i = input as { outletId?: unknown };
  if (typeof i.outletId === "string" && i.outletId) assertOutletAccess(ctx, i.outletId); // before reading the outlet's timezone
  try {
    return await resolveDateFilters(db, ctx, input as Record<string, unknown>);
  } catch (e) {
    if (e instanceof RangeError) throw new ValidationError(e.message);
    throw e;
  }
}

function getDef(reportId: string): AnyReport {
  const def = REPORTS[reportId];
  if (!def) throw new NotFoundError(`Unknown report "${reportId}"`);
  return def;
}

/** Validate filters, authorize, run, and cap. Rows come back keyed by column key, in column order. */
export async function runReport(db: PrismaClient, ctx: AccessContext, reportId: string, input: unknown = {}): Promise<ReportResult & { raw: unknown[]; def: AnyReport }> {
  const def = getDef(reportId);
  const parsed = def.schema.safeParse(await normalizeDates(db, ctx, input));
  if (!parsed.success) throw new ValidationError("Invalid report filters", parsed.error.flatten());
  const f = parsed.data as Base;
  if (f.outletId) assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, def.permission, f.outletId);
  const limit = Math.min(f.limit ?? def.maxRows, def.maxRows);
  const fetched = await def.run({ db, ctx, f, limit, offset: f.offset });
  const truncated = fetched.length > limit;
  const raw = fetched.slice(0, limit);
  return {
    report: def.id,
    title: def.title,
    columns: def.columns.map((c) => ({ key: c.key, header: c.header })),
    rows: raw.map((r) => Object.fromEntries(def.columns.map((c) => [c.key, cell(c.value(r))]))),
    rowCount: raw.length,
    truncated,
    offset: f.offset,
    nextOffset: truncated ? f.offset + limit : null,
    raw,
    def,
  };
}

/** Public JSON form (without internals). */
export async function getReport(db: PrismaClient, ctx: AccessContext, reportId: string, input: unknown = {}): Promise<ReportResult> {
  const full = await runReport(db, ctx, reportId, input);
  return { report: full.report, title: full.title, columns: full.columns, rows: full.rows, rowCount: full.rowCount, truncated: full.truncated, offset: full.offset, nextOffset: full.nextOffset };
}

export type ExportResult = { exportJobId: string; filename: string; csv: string; rowCount: number; truncated: boolean };

/**
 * Export a report as CSV. Requires `export.run` (at the requested outlet, if
 * any) plus the report's own permission. Creates an ExportJob and, on
 * success, an EXPORT audit row; failures mark the job FAILED with the error.
 */
export async function exportReportCSV(ctx: AccessContext, reportId: string, input: unknown = {}, db: PrismaClient = prisma): Promise<ExportResult> {
  const def = getDef(reportId);
  const parsed = def.schema.safeParse(await normalizeDates(db, ctx, input));
  if (!parsed.success) throw new ValidationError("Invalid report filters", parsed.error.flatten());
  const f = parsed.data as Base;
  if (f.outletId) assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "export.run", f.outletId);
  assertCan(ctx, def.permission, f.outletId);

  const params = JSON.stringify(f);
  const job = await db.exportJob.create({
    data: { organizationId: ctx.organizationId, outletId: f.outletId ?? null, kind: def.id, format: "CSV", status: "RUNNING", params, requestedById: ctx.userId === "system" ? null : ctx.userId },
  });
  try {
    const result = await runReport(db, ctx, reportId, f);
    const csv = toCSV(result.raw, def.columns as CsvColumn<unknown>[]);
    await db.$transaction(async (tx) => {
      await tx.exportJob.update({ where: { id: job.id }, data: { status: "SUCCESS", rowCount: result.rowCount, finishedAt: new Date() } });
      await writeAudit(tx, ctx, { action: "EXPORT", entityType: "ExportJob", entityId: job.id, outletId: f.outletId ?? null, after: { report: def.id, filters: f, rowCount: result.rowCount, truncated: result.truncated } });
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return { exportJobId: job.id, filename: `${def.id.toLowerCase()}-${stamp}.csv`, csv, rowCount: result.rowCount, truncated: result.truncated };
  } catch (e: unknown) {
    const err = e as { message?: string; status?: number };
    // Record only a safe message; internal errors are not exposed in the job.
    const message = typeof err?.status === "number" && err.status < 500 ? String(err.message) : "Internal error";
    await db.exportJob.update({ where: { id: job.id }, data: { status: "FAILED", error: message, finishedAt: new Date() } });
    throw e;
  }
}

export async function listExportJobs(db: PrismaClient, ctx: AccessContext, opts: { take?: number; cursor?: string } = {}) {
  assertCan(ctx, "export.run");
  const take = Math.min(opts.take ?? 50, 200);
  const mine = ctx.isOrgWide || ctx.isSuperAdmin ? {} : { requestedById: ctx.userId };
  const rows = await db.exportJob.findMany({
    where: { organizationId: ctx.organizationId, ...mine },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}
