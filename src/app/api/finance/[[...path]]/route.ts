import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, outletQuery } from "@/server/api/router";
import {
  listExpenses, createExpense, expensesByCategory, recordPettyCash, pettyCashBalance, openCashDrawer, closeCashDrawer,
  computeDailyExpected, saveDailyReconciliation, completeDailyReconciliation, dailyClosing, computePnL, vendorDues,
} from "@/server/services/finance";
import {
  runPOSReconciliation, runPaymentReconciliation, runAggregatorReconciliation, runVendorPaymentReconciliation, listReconciliations, getReconciliation,
  type ReconciliationKind,
} from "@/server/services/reconciliation";
import { listPayments, listRefunds, listPettyCash, listDrawerSessions } from "@/server/services/adminQueries";
import { resolveProvider } from "@/server/services/webhooks";
import { businessDateInput, resolveDateFilters } from "@/server/services/businessDay";
import type { POSProvider } from "@/integrations/pos";
import type { PaymentProvider } from "@/integrations/payment";

export const runtime = "nodejs";

const range = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const day = outletQuery.extend({ businessDate: businessDateInput });
const runBody = z.object({ outletId: z.string(), businessDate: businessDateInput, finalize: z.boolean().default(false) });
const kind = z.enum(["PAYMENTS", "POS", "GATEWAY", "AGGREGATOR", "VENDOR"]);

export const { GET, POST } = createRouter([
  // payments / refunds / petty cash / drawer (read-only lists)
  { method: "GET", path: "payments", handler: ({ ctx, query }) => listPayments(prisma, ctx, query) },
  { method: "GET", path: "refunds", handler: ({ ctx, query }) => listRefunds(prisma, ctx, query) },
  { method: "GET", path: "petty-cash", handler: ({ ctx, query }) => listPettyCash(prisma, ctx, query as never) },
  { method: "GET", path: "drawer", handler: ({ ctx, query }) => listDrawerSessions(prisma, ctx, query as never) },
  // expenses + petty cash
  { method: "GET", path: "expenses", handler: ({ ctx, query }) => listExpenses(prisma, ctx, outletQuery.merge(range).extend({ category: z.string().optional(), take: z.coerce.number().int().positive().max(500).optional(), skip: z.coerce.number().int().min(0).optional() }).parse(query)) },
  { method: "POST", path: "expenses", handler: ({ ctx, body }) => createExpense(ctx, body as never) },
  { method: "GET", path: "expenses/by-category", handler: ({ ctx, query }) => expensesByCategory(prisma, ctx, outletQuery.merge(range).parse(query)) },
  { method: "POST", path: "petty-cash", handler: ({ ctx, body }) => recordPettyCash(ctx, body as never) },
  { method: "GET", path: "petty-cash/balance", handler: async ({ ctx, query }) => ({ balance: await pettyCashBalance(prisma, ctx, outletQuery.parse(query).outletId) }) },
  // cash drawer
  { method: "POST", path: "drawer/open", handler: ({ ctx, body }) => openCashDrawer(ctx, body as never) },
  { method: "POST", path: "drawer/:id/close", handler: ({ ctx, params, body }) => closeCashDrawer(ctx, params.id, z.object({ closingCount: z.number().nonnegative() }).parse(body).closingCount) },
  // daily figures
  { method: "GET", path: "daily-expected", handler: ({ ctx, query }) => { const q = day.parse(query); return computeDailyExpected(prisma, ctx, q.outletId, q.businessDate); } },
  { method: "GET", path: "closing", handler: ({ ctx, query }) => { const q = day.parse(query); return dailyClosing(prisma, ctx, q.outletId, q.businessDate); } },
  { method: "GET", path: "pnl", handler: async ({ ctx, query }) => computePnL(prisma, ctx, range.extend({ outletId: z.string().optional() }).parse(await resolveDateFilters(prisma, ctx, query))) },
  { method: "GET", path: "vendor-dues", handler: ({ ctx, query }) => vendorDues(prisma, ctx, z.object({ outletId: z.string().optional(), vendorId: z.string().optional(), asOf: z.coerce.date().optional() }).parse(query)) },
  // reconciliation
  { method: "GET", path: "reconciliations", handler: ({ ctx, query }) => listReconciliations(prisma, ctx, outletQuery.extend({ kind: kind.optional(), take: z.coerce.number().int().positive().max(200).optional(), cursor: z.string().optional() }).parse(query)) },
  { method: "GET", path: "reconciliations/one", handler: ({ ctx, query }) => getReconciliation(prisma, ctx, day.extend({ kind }).parse(query) as { outletId: string; businessDate: string | Date; kind: ReconciliationKind }) },
  { method: "POST", path: "reconciliations/daily", handler: ({ ctx, body }) => saveDailyReconciliation(ctx, body as never) },
  { method: "POST", path: "reconciliations/:id/complete", handler: ({ ctx, params }) => completeDailyReconciliation(ctx, params.id) },
  {
    method: "POST", path: "reconciliations/pos",
    handler: async ({ ctx, body }) => {
      const b = runBody.extend({ provider: z.string().default("mock"), autoImport: z.boolean().default(false) }).parse(body);
      return runPOSReconciliation(ctx, { ...b, provider: resolveProvider("POS", b.provider) as POSProvider });
    },
  },
  {
    method: "POST", path: "reconciliations/gateway",
    handler: async ({ ctx, body }) => {
      const b = runBody.extend({ provider: z.string().default("mock") }).parse(body);
      return runPaymentReconciliation(ctx, { ...b, provider: resolveProvider("PAYMENT", b.provider) as PaymentProvider });
    },
  },
  { method: "POST", path: "reconciliations/aggregator", handler: ({ ctx, body }) => runAggregatorReconciliation(ctx, runBody.extend({ aggregatorId: z.string() }).parse(body)) },
  { method: "POST", path: "reconciliations/vendor", handler: ({ ctx, body }) => runVendorPaymentReconciliation(ctx, runBody.parse(body)) },
]);
