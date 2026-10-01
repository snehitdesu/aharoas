import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import * as A from "@/server/services/analytics";
import { NotFoundError } from "@/server/db/scope";

export const runtime = "nodejs";

const filter = z.object({
  outletId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  utcOffsetMinutes: z.coerce.number().int().min(-720).max(840).optional(),
});

const metrics = {
  dashboard: A.dashboardKPIs,
  "sales-summary": A.salesSummary,
  "daily-sales": A.dailySales,
  "day-parts": A.dayPartSales,
  items: A.itemSales,
  categories: A.categorySales,
  payments: A.paymentsByMethod,
  refunds: A.refundsByMethod,
  "food-cost": A.foodCost,
  wastage: A.wastageCost,
  purchases: A.purchasesTotal,
  expenses: A.expensesTotal,
  "inventory-value": A.inventoryValue,
  "stock-variance": A.stockVariance,
} as const;

// GET /api/analytics/:metric?outletId&from&to  (every metric enforces reports.view + outlet scope)
export const { GET } = createRouter([
  {
    method: "GET",
    path: ":metric",
    handler: async ({ ctx, params, query }) => {
      const fn = metrics[params.metric as keyof typeof metrics];
      if (!fn) throw new NotFoundError(`Unknown metric "${params.metric}"`);
      return fn(prisma, ctx, filter.parse(query));
    },
  },
]);
