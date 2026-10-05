import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, listQuery, outletQuery } from "@/server/api/router";
import { assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { stockByOutlet, lowStock, stockMovement, recordOpeningStock, adjustStock } from "@/server/services/inventory";
import { listUnmappedSales, resolveUnmappedSale } from "@/server/services/unmapped";
import { createWastage, postWastage, cancelWastage, listWastage } from "@/server/services/wastage";
import { createProductionBatch, startProductionBatch, completeProductionBatch, cancelProductionBatch, listProductionBatches } from "@/server/services/production";
import {
  createTransfer, dispatchTransfer, receiveTransfer, cancelTransfer,
  createIssue, postIssue, cancelIssue,
  createStockCount, startStockCount, enterStockCounts, submitStockCountForReview, approveStockCount, cancelStockCount,
} from "@/server/services/stockOps";
import { listLedger } from "@/server/services/adminQueries";
import { num } from "@/domain/money";
import { listTransfers, getTransfer, listIssues, getIssue, listStockCounts, getStockCount, getWastage, getProductionBatch } from "@/server/services/documentQueries";

export const runtime = "nodejs";

const status = z.object({ status: z.string().optional() });
const dispatchBody = z.object({ lines: z.array(z.object({ lineId: z.string(), dispatchedQty: z.number().nonnegative() })).optional() });
const receiveBody = z.object({ lines: z.array(z.object({ lineId: z.string(), receivedQty: z.number().nonnegative(), damagedQty: z.number().nonnegative().optional() })).optional() });
const countStart = z.object({ materialIds: z.array(z.string()).optional() });
const countEntries = z.object({ entries: z.array(z.object({ materialId: z.string(), physicalQty: z.number().nonnegative(), unitId: z.string().optional() })).min(1) });
/** Idempotency-Key header: a retried create returns the original document. */
const idemKey = (req: { headers: Headers }) => req.headers.get("idempotency-key") ?? undefined;

/** Read helpers in inventory.ts do not authorize themselves; the route does. */
function canViewInventory(ctx: Parameters<typeof assertCan>[0], outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "inventory.view", outletId);
}

export const { GET, POST } = createRouter([
  // ---- stock ----
  {
    method: "GET", path: "stock",
    handler: async ({ ctx, query }) => {
      const { outletId } = outletQuery.parse(query);
      canViewInventory(ctx, outletId);
      const rows = await stockByOutlet(prisma, ctx, outletId);
      // Additive display fields (name / sku / unit / reorder level) resolved in one bounded query.
      const materials = await prisma.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: rows.map((r) => r.materialId) } }, select: { id: true, name: true, sku: true, reorderLevel: true, active: true, categoryId: true, baseUnit: { select: { code: true } } } });
      const byId = new Map(materials.map((m) => [m.id, m]));
      return rows.map((r) => {
        const m = byId.get(r.materialId);
        return { materialId: r.materialId, quantity: num(r.quantity), avgCost: num(r.avgCost), value: num(r.value), name: m?.name ?? null, sku: m?.sku ?? null, unit: m?.baseUnit?.code ?? null, reorderLevel: m ? num(m.reorderLevel) : 0, active: m?.active ?? false, categoryId: m?.categoryId ?? null };
      });
    },
  },
  {
    method: "GET", path: "low-stock",
    handler: async ({ ctx, query }) => {
      const { outletId } = outletQuery.parse(query);
      canViewInventory(ctx, outletId);
      return (await lowStock(prisma, ctx, outletId)).map((r) => ({ materialId: r.material.id, sku: r.material.sku, name: r.material.name, quantity: num(r.quantity), reorderLevel: num(r.reorderLevel) }));
    },
  },
  {
    method: "GET", path: "movements",
    handler: async ({ ctx, query }) => {
      const q = outletQuery.extend({ materialId: z.string().min(1), take: z.coerce.number().int().positive().max(500).default(100) }).parse(query);
      canViewInventory(ctx, q.outletId);
      return stockMovement(prisma, ctx, q.outletId, q.materialId, q.take);
    },
  },
  { method: "GET", path: "ledger", handler: ({ ctx, query }) => listLedger(prisma, ctx, query as never) },
  // ---- opening stock / manual adjustments ----
  { method: "POST", path: "opening-stock", handler: ({ ctx, body }) => recordOpeningStock(ctx, body as never) },
  { method: "POST", path: "adjustments", handler: ({ ctx, body, req }) => adjustStock(ctx, body as never, idemKey(req)) },
  // ---- unmapped-sale queue ----
  { method: "GET", path: "unmapped", handler: ({ ctx, query }) => listUnmappedSales(prisma, ctx, query as never) },
  { method: "POST", path: "unmapped/:id/resolve", handler: ({ ctx, params, body }) => resolveUnmappedSale(ctx, params.id, body as never) },
  // ---- wastage documents ----
  { method: "GET", path: "wastage", handler: ({ ctx, query }) => listWastage(prisma, ctx, { ...listQuery.extend({ outletId: z.string() }).parse(query), ...status.parse(query) } as never) },
  { method: "GET", path: "wastage/:id", handler: ({ ctx, params }) => getWastage(prisma, ctx, params.id) },
  { method: "POST", path: "wastage", handler: ({ ctx, body, req }) => createWastage(ctx, body as never, undefined, idemKey(req)) },
  { method: "POST", path: "wastage/:id/post", handler: ({ ctx, params }) => postWastage(ctx, params.id) },
  { method: "POST", path: "wastage/:id/cancel", handler: ({ ctx, params }) => cancelWastage(ctx, params.id) },
  // ---- production ----
  { method: "GET", path: "production", handler: ({ ctx, query }) => listProductionBatches(prisma, ctx, { ...listQuery.extend({ outletId: z.string() }).parse(query), ...status.parse(query) } as never) },
  { method: "GET", path: "production/:id", handler: ({ ctx, params }) => getProductionBatch(prisma, ctx, params.id) },
  { method: "POST", path: "production", handler: ({ ctx, body }) => createProductionBatch(ctx, body as never) },
  { method: "POST", path: "production/:id/start", handler: ({ ctx, params }) => startProductionBatch(ctx, params.id) },
  { method: "POST", path: "production/:id/complete", handler: ({ ctx, params, body }) => completeProductionBatch(ctx, params.id, body as never) },
  { method: "POST", path: "production/:id/cancel", handler: ({ ctx, params }) => cancelProductionBatch(ctx, params.id) },
  // ---- transfers ----
  { method: "GET", path: "transfers", handler: ({ ctx, query }) => listTransfers(prisma, ctx, query) },
  { method: "GET", path: "transfers/:id", handler: ({ ctx, params }) => getTransfer(prisma, ctx, params.id) },
  { method: "POST", path: "transfers", handler: ({ ctx, body, req }) => createTransfer(ctx, body as never, undefined, idemKey(req)) },
  { method: "POST", path: "transfers/:id/dispatch", handler: ({ ctx, params, body }) => dispatchTransfer(ctx, params.id, dispatchBody.parse(body).lines) },
  { method: "POST", path: "transfers/:id/receive", handler: ({ ctx, params, body }) => receiveTransfer(ctx, params.id, receiveBody.parse(body).lines) },
  { method: "POST", path: "transfers/:id/cancel", handler: ({ ctx, params }) => cancelTransfer(ctx, params.id) },
  // ---- issues ----
  { method: "GET", path: "issues", handler: ({ ctx, query }) => listIssues(prisma, ctx, query) },
  { method: "GET", path: "issues/:id", handler: ({ ctx, params }) => getIssue(prisma, ctx, params.id) },
  { method: "POST", path: "issues", handler: ({ ctx, body, req }) => createIssue(ctx, body as never, undefined, idemKey(req)) },
  { method: "POST", path: "issues/:id/post", handler: ({ ctx, params }) => postIssue(ctx, params.id) },
  { method: "POST", path: "issues/:id/cancel", handler: ({ ctx, params }) => cancelIssue(ctx, params.id) },
  // ---- stock counts ----
  { method: "GET", path: "counts", handler: ({ ctx, query }) => listStockCounts(prisma, ctx, query) },
  { method: "GET", path: "counts/:id", handler: ({ ctx, params }) => getStockCount(prisma, ctx, params.id) },
  { method: "POST", path: "counts", handler: ({ ctx, body }) => createStockCount(ctx, z.object({ outletId: z.string(), departmentId: z.string().optional() }).parse(body)) },
  { method: "POST", path: "counts/:id/start", handler: ({ ctx, params, body }) => startStockCount(ctx, params.id, countStart.parse(body)) },
  { method: "POST", path: "counts/:id/entries", handler: ({ ctx, params, body }) => enterStockCounts(ctx, params.id, countEntries.parse(body).entries) },
  { method: "POST", path: "counts/:id/submit", handler: ({ ctx, params }) => submitStockCountForReview(ctx, params.id) },
  { method: "POST", path: "counts/:id/approve", handler: ({ ctx, params }) => approveStockCount(ctx, params.id) },
  { method: "POST", path: "counts/:id/cancel", handler: ({ ctx, params }) => cancelStockCount(ctx, params.id) },
]);
