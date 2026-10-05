import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, outletQuery } from "@/server/api/router";
import { RATE_POLICIES } from "@/server/api/rateLimit";
import { createPrinter, kickCashDrawer, listPrinters, listPrintJobs, printerStatus, printKot, printReceipt, retryPrintJob, testPrint, updatePrinter } from "@/server/services/printing";

export const runtime = "nodejs";

// Printers, print jobs and the cash drawer. Printing never changes an order / payment / drawer record.
export const { GET, POST, PATCH } = createRouter([
  { method: "GET", path: "printers", handler: ({ ctx, query }) => listPrinters(prisma, ctx, outletQuery.parse(query).outletId) },
  { method: "POST", path: "printers", reauth: "settings.manage", handler: ({ ctx, body }) => createPrinter(ctx, body as never) },
  { method: "PATCH", path: "printers/:id", reauth: "settings.manage", handler: ({ ctx, params, body }) => updatePrinter(ctx, params.id, body as never) },
  { method: "POST", path: "printers/:id/test", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params }) => testPrint(ctx, params.id) },
  { method: "GET", path: "printers/:id/status", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params }) => printerStatus(ctx, params.id) },
  { method: "GET", path: "jobs", handler: ({ ctx, query }) => listPrintJobs(prisma, ctx, query as never) },
  { method: "POST", path: "jobs/:id/retry", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params }) => retryPrintJob(ctx, params.id) },
  { method: "POST", path: "orders/:id/receipt", handler: ({ ctx, params, body }) => printReceipt(ctx, params.id, body as never) },
  { method: "POST", path: "kots/:id", handler: ({ ctx, params, body }) => printKot(ctx, params.id, body as never) },
  { method: "POST", path: "drawer/kick", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, body }) => kickCashDrawer(ctx, z.object({ outletId: z.string().min(1), reason: z.string().min(3).max(120) }).parse(body)) },
]);
