/**
 * Read/list queries for procurement and stock documents. Every list resolves
 * its outlet scope via `authorizedOutletIds` (org + outlets where the actor
 * holds the permission; an explicit foreign outlet is a 403), filters in the
 * database, orders deterministically (createdAt desc, id desc) and pages with a
 * cursor (max 200). Single-document reads re-check org + outlet access.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess, NotFoundError, ForbiddenError } from "@/server/db/scope";
import { assertCan, can, type Permission } from "@/server/auth/rbac";
import { authorizedOutletIds } from "@/server/services/analytics";

const listFilter = z.object({
  outletId: z.string().optional(),
  status: z.string().max(20).optional(),
  vendorId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  take: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});
export type DocumentListFilter = z.input<typeof listFilter>;

const ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];

function prep(ctx: AccessContext, input: DocumentListFilter, permission: Permission) {
  const f = listFilter.parse(input);
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, permission);
  const createdAt = f.from || f.to ? { gte: f.from, lte: f.to } : undefined;
  return { f, ids, createdAt };
}

function paged<T extends { id: string }>(rows: T[], take: number) {
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

const cursorArgs = (cursor?: string): { cursor?: { id: string }; skip?: number } => (cursor ? { cursor: { id: cursor }, skip: 1 } : {});

function readable<T extends { organizationId: string; outletId: string }>(ctx: AccessContext, row: T | null, what: string, permission: Permission): T {
  if (!row || row.organizationId !== ctx.organizationId) throw new NotFoundError(`${what} not found`);
  assertOutletAccess(ctx, row.outletId);
  assertCan(ctx, permission, row.outletId);
  return row;
}

// ---------------- procurement ----------------

export async function listIndents(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "purchase.view");
  const rows = await db.purchaseIndent.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.status ? { status: f.status } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor), include: { _count: { select: { lines: true } } },
  });
  return paged(rows, f.take);
}

export async function getIndent(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.purchaseIndent.findUnique({ where: { id }, include: { lines: true } }), "Indent", "purchase.view");
}

export async function listPurchaseOrders(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "purchase.view");
  const rows = await db.purchaseOrder.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.status ? { status: f.status } : {}), ...(f.vendorId ? { vendorId: f.vendorId } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor), include: { _count: { select: { lines: true, receipts: true } } },
  });
  return paged(rows, f.take);
}

export async function getPurchaseOrder(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.purchaseOrder.findUnique({ where: { id }, include: { lines: true, receipts: { select: { id: true, number: true, status: true, receivedAt: true } } } }), "Purchase order", "purchase.view");
}

export async function listGRNs(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "purchase.view");
  const rows = await db.goodsReceipt.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.status ? { status: f.status } : {}), ...(f.vendorId ? { vendorId: f.vendorId } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor), include: { _count: { select: { lines: true } } },
  });
  return paged(rows, f.take);
}

export async function getGRN(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.goodsReceipt.findUnique({ where: { id }, include: { lines: true, bills: { select: { id: true, number: true, status: true } } } }), "GRN", "purchase.view");
}

export async function listPurchaseBills(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "purchase.view");
  const rows = await db.purchaseBill.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.status ? { status: f.status } : {}), ...(f.vendorId ? { vendorId: f.vendorId } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor),
  });
  return paged(rows, f.take);
}

export async function getPurchaseBill(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.purchaseBill.findUnique({ where: { id }, include: { lines: true, payments: true } }), "Bill", "purchase.view");
}

export async function listVendorPayments(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "finance.view");
  const rows = await db.vendorPayment.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.vendorId ? { vendorId: f.vendorId } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor),
  });
  return paged(rows, f.take);
}

// ---------------- stock ----------------

export async function listTransfers(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "inventory.view");
  const rows = await db.inventoryTransfer.findMany({
    where: { organizationId: ctx.organizationId, OR: [{ fromOutletId: { in: ids } }, { toOutletId: { in: ids } }], ...(f.status ? { status: f.status } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor), include: { _count: { select: { lines: true } } },
  });
  return paged(rows, f.take);
}

/** Visible to inventory viewers at either end of the transfer. */
export async function getTransfer(db: PrismaClient, ctx: AccessContext, id: string) {
  const t = await db.inventoryTransfer.findUnique({ where: { id }, include: { lines: true } });
  if (!t || t.organizationId !== ctx.organizationId) throw new NotFoundError("Transfer not found");
  const visible = [t.fromOutletId, t.toOutletId].some((o) => (ctx.isOrgWide || ctx.isSuperAdmin || ctx.outletIds.includes(o)) && can(ctx, "inventory.view", o));
  if (!visible) throw new ForbiddenError("No access to this transfer");
  return t;
}

export async function listIssues(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "inventory.view");
  const rows = await db.inventoryIssue.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.status ? { status: f.status } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor), include: { _count: { select: { lines: true } } },
  });
  return paged(rows, f.take);
}

export async function getIssue(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.inventoryIssue.findUnique({ where: { id }, include: { lines: true } }), "Issue", "inventory.view");
}

export async function listStockCounts(db: PrismaClient, ctx: AccessContext, input: DocumentListFilter = {}) {
  const { f, ids, createdAt } = prep(ctx, input, "inventory.view");
  const rows = await db.stockCount.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ids }, ...(f.status ? { status: f.status } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: ORDER, take: f.take + 1, ...cursorArgs(f.cursor), include: { _count: { select: { lines: true } } },
  });
  return paged(rows, f.take);
}

export async function getStockCount(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.stockCount.findUnique({ where: { id }, include: { lines: true } }), "Stock count", "inventory.view");
}

export async function getWastage(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.wastage.findUnique({ where: { id }, include: { lines: true } }), "Wastage document", "inventory.view");
}

export async function getProductionBatch(db: PrismaClient, ctx: AccessContext, id: string) {
  return readable(ctx, await db.productionBatch.findUnique({ where: { id }, include: { lines: true } }), "Production batch", "inventory.view");
}
