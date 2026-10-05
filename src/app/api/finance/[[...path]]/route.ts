import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, outletQuery } from "@/server/api/router";
import {
  listExpenses, createExpense, voidExpense, expensesByCategory, listExpenseCategories, createExpenseCategory, setExpenseCategoryActive,
  recordPettyCash, pettyCashBalance, openCashDrawer, closeCashDrawer, recordDrawerMovement,
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

import { vendorAging, vendorStatement, reverseVendorPayment } from "@/server/services/vendorFinance";
import { listInvoices, taxSummary } from "@/server/services/invoicing";
import { authorizedOutletIds } from "@/server/services/analytics";

import { runAfterCommit } from "@/server/services/afterCommit";
import type { AccessContext } from "@/server/db/scope";

const cashMoved = (ctx: AccessContext, outletId: string, reason: string) =>
  runAfterCommit("cash-movement", async () => (await import("@/server/services/integrationHooks")).afterCashMovement(ctx, outletId, reason));

export const runtime = "nodejs";

/** Idempotency-Key header: a retried submission returns the original record. */
const idemKey = (req: { headers: Headers }) => req.headers.get("idempotency-key") ?? undefined;

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
  { method: "GET", path: "expenses", handler: ({ ctx, query }) => listExpenses(prisma, ctx, outletQuery.merge(range).extend({ category: z.string().optional(), take: z.coerce.number().int().positive().max(500).optional(), skip: z.coerce.number().int().min(0).optional(), includeVoided: z.enum(["true", "false"]).optional().transform((v) => v === "true") }).parse(query)) },
  { method: "POST", path: "expenses", handler: ({ ctx, body, req }) => createExpense(ctx, body as never, undefined, idemKey(req)) },
  { method: "POST", path: "expenses/:id/void", reauth: "finance.void", handler: ({ ctx, params, body }) => voidExpense(ctx, params.id, z.object({ reason: z.string() }).parse(body).reason) },
  { method: "GET", path: "expense-categories", handler: ({ ctx, query }) => listExpenseCategories(prisma, ctx, { includeInactive: query.includeInactive === "true" }) },
  { method: "POST", path: "expense-categories", handler: ({ ctx, body }) => createExpenseCategory(ctx, body as never) },
  { method: "POST", path: "expense-categories/:id/active", handler: ({ ctx, params, body }) => setExpenseCategoryActive(ctx, params.id, z.object({ active: z.boolean() }).parse(body).active) },
  { method: "GET", path: "expenses/by-category", handler: ({ ctx, query }) => expensesByCategory(prisma, ctx, outletQuery.merge(range).parse(query)) },
  { method: "POST", path: "petty-cash", handler: ({ ctx, body, req }) => recordPettyCash(ctx, body as never, undefined, idemKey(req)) },
  { method: "GET", path: "petty-cash/balance", handler: async ({ ctx, query }) => ({ balance: await pettyCashBalance(prisma, ctx, outletQuery.parse(query).outletId) }) },
  // cash drawer
  // A configured cash drawer opens after the movement is committed (hardware never affects the money records).
  { method: "POST", path: "drawer/open", handler: ({ ctx, body }) => openCashDrawer(ctx, body as never).then((s) => { cashMoved(ctx, s.outletId, "Drawer opened"); return s; }) },
  { method: "POST", path: "drawer/:id/close", handler: ({ ctx, params, body }) => closeCashDrawer(ctx, params.id, z.object({ closingCount: z.number().nonnegative() }).parse(body).closingCount) },
  { method: "POST", path: "drawer/:id/movements", handler: ({ ctx, params, body, req }) => recordDrawerMovement(ctx, params.id, body as never, undefined, idemKey(req)).then((m) => { if (!(m as { replayed?: boolean }).replayed) cashMoved(ctx, (m as { outletId: string }).outletId, "Cash in / out"); return m; }) },
  // daily figures
  { method: "GET", path: "daily-expected", handler: ({ ctx, query }) => { const q = day.parse(query); return computeDailyExpected(prisma, ctx, q.outletId, q.businessDate); } },
  { method: "GET", path: "closing", handler: ({ ctx, query }) => { const q = day.parse(query); return dailyClosing(prisma, ctx, q.outletId, q.businessDate); } },
  { method: "GET", path: "pnl", handler: async ({ ctx, query }) => computePnL(prisma, ctx, range.extend({ outletId: z.string().optional() }).parse(await resolveDateFilters(prisma, ctx, query))) },
  { method: "GET", path: "vendor-dues", handler: ({ ctx, query }) => vendorDues(prisma, ctx, z.object({ outletId: z.string().optional(), vendorId: z.string().optional(), asOf: z.coerce.date().optional() }).parse(query)) },
  { method: "GET", path: "vendor-aging", handler: ({ ctx, query }) => vendorAging(prisma, ctx, z.object({ outletId: z.string().optional(), vendorId: z.string().optional(), asOf: z.coerce.date().optional() }).parse(query)) },
  { method: "GET", path: "vendor-statement", handler: ({ ctx, query }) => vendorStatement(prisma, ctx, query as never) },
  { method: "POST", path: "vendor-payments/:id/reverse", reauth: "finance.void", handler: ({ ctx, params, body }) => reverseVendorPayment(ctx, params.id, z.object({ reason: z.string() }).parse(body).reason) },
  // invoices / tax
  { method: "GET", path: "invoices", handler: ({ ctx, query }) => listInvoices(prisma, ctx, query as never) },
  { method: "GET", path: "tax-summary", handler: ({ ctx, query }) => { const q = range.extend({ outletId: z.string().optional() }).parse(query); return taxSummary(prisma, ctx, { outletIds: authorizedOutletIds(ctx, { outletId: q.outletId }, "finance.view"), from: q.from, to: q.to }); } },
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
