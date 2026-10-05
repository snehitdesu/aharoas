import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import * as A from "@/server/services/analytics";
import { financeOverview } from "@/server/services/financeAnalytics";
import { businessInsights } from "@/server/services/insights";
import { NotFoundError, ValidationError } from "@/server/db/scope";
import { normalizeDates } from "@/server/services/reports";
import { assertOutletInOrg } from "@/server/db/outletGuard";

export const runtime = "nodejs";

/** Longest period one analytics request may cover. */
const MAX_RANGE_DAYS = 400;

const filter = z
  .object({
    outletId: z.string().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).optional(),
    granularity: z.enum(["day", "week", "month"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    lookbackDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: "`from` must be on or before `to`", path: ["from"] })
  .refine((f) => !f.from || !f.to || f.to.getTime() - f.from.getTime() <= MAX_RANGE_DAYS * 86400000, { message: `The period may cover at most ${MAX_RANGE_DAYS} days`, path: ["to"] });

const metrics = {
  dashboard: A.dashboardKPIs,
  "sales-summary": A.salesSummary,
  "daily-sales": A.dailySales,
  "sales-trend": A.salesTrend,
  "outlet-comparison": A.outletComparison,
  "day-parts": A.dayPartSales,
  items: A.itemSales,
  "menu-performance": A.menuPerformance,
  categories: A.categorySales,
  variants: A.variantSales,
  modifiers: A.modifierSales,
  payments: A.paymentsByMethod,
  refunds: A.refundsByMethod,
  "food-cost": A.foodCost,
  wastage: A.wastageCost,
  purchases: A.purchasesTotal,
  "purchase-trend": A.purchaseTrend,
  "vendor-purchasing": A.vendorPurchasing,
  expenses: A.expensesTotal,
  "inventory-value": A.inventoryValue,
  "stock-variance": A.stockVariance,
  consumption: A.materialConsumption,
  "inventory-movement": A.inventoryMovement,
  "stock-ageing": A.stockAgeing,
  "negative-stock": A.negativeStockReport,
  unmapped: A.unmappedSalesSummary,
  finance: financeOverview,
} as const;

async function parseFilter(ctx: Parameters<typeof normalizeDates>[1], query: Record<string, unknown>) {
  // Another tenant's outlet id is "not found" (reads are org-scoped anyway; this makes it explicit).
  if (typeof query.outletId === "string" && query.outletId) await assertOutletInOrg(prisma, ctx, query.outletId);
  // Date-only from/to = whole business days in the outlet's (or organization's) timezone, `to` inclusive.
  const parsed = filter.safeParse(await normalizeDates(prisma, ctx, query));
  if (!parsed.success) throw new ValidationError("Invalid analytics filters", parsed.error.flatten());
  return parsed.data;
}

// GET /api/analytics/:metric?outletId&from&to  (every metric enforces its permission + outlet scope)
// GET /api/analytics/insights?outletId          (deterministic business rules; per-rule permissions)
export const { GET } = createRouter([
  {
    method: "GET",
    path: "insights",
    handler: async ({ ctx, query }) => {
      const q = z.object({ outletId: z.string().min(1, "outletId is required") }).safeParse(query);
      if (!q.success) throw new ValidationError("Invalid insight filters", q.error.flatten());
      return businessInsights(prisma, ctx, { outletId: q.data.outletId });
    },
  },
  {
    method: "GET",
    path: ":metric",
    handler: async ({ ctx, params, query }) => {
      const fn = metrics[params.metric as keyof typeof metrics] as ((db: typeof prisma, c: typeof ctx, f: z.infer<typeof filter>) => Promise<unknown>) | undefined;
      if (!fn) throw new NotFoundError(`Unknown metric "${params.metric}"`);
      return fn(prisma, ctx, await parseFilter(ctx, query));
    },
  },
]);
