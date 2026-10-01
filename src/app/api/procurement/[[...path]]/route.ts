import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { IndentStatus, PurchaseOrderStatus } from "@/constants/enums";
import {
  createIndent, transitionIndent, createPurchaseOrder, transitionPurchaseOrder,
  createGRN, postGRN, createPurchaseBill, cancelPurchaseBill, payVendor, vendorDues,
} from "@/server/services/procurement";
import {
  listIndents, getIndent, listPurchaseOrders, getPurchaseOrder, listGRNs, getGRN, listPurchaseBills, getPurchaseBill, listVendorPayments,
} from "@/server/services/documentQueries";

export const runtime = "nodejs";

export const { GET, POST } = createRouter([
  // reads (paginated, outlet-scoped)
  { method: "GET", path: "indents", handler: ({ ctx, query }) => listIndents(prisma, ctx, query) },
  { method: "GET", path: "indents/:id", handler: ({ ctx, params }) => getIndent(prisma, ctx, params.id) },
  { method: "GET", path: "purchase-orders", handler: ({ ctx, query }) => listPurchaseOrders(prisma, ctx, query) },
  { method: "GET", path: "purchase-orders/:id", handler: ({ ctx, params }) => getPurchaseOrder(prisma, ctx, params.id) },
  { method: "GET", path: "grns", handler: ({ ctx, query }) => listGRNs(prisma, ctx, query) },
  { method: "GET", path: "grns/:id", handler: ({ ctx, params }) => getGRN(prisma, ctx, params.id) },
  { method: "GET", path: "bills", handler: ({ ctx, query }) => listPurchaseBills(prisma, ctx, query) },
  { method: "GET", path: "bills/:id", handler: ({ ctx, params }) => getPurchaseBill(prisma, ctx, params.id) },
  { method: "GET", path: "vendor-payments", handler: ({ ctx, query }) => listVendorPayments(prisma, ctx, query) },
  // commands
  { method: "POST", path: "indents", handler: ({ ctx, body }) => createIndent(ctx, body as never) },
  { method: "POST", path: "indents/:id/transition", handler: ({ ctx, params, body }) => transitionIndent(ctx, params.id, z.object({ to: IndentStatus.zod }).parse(body).to) },
  { method: "POST", path: "purchase-orders", handler: ({ ctx, body }) => createPurchaseOrder(ctx, body as never) },
  { method: "POST", path: "purchase-orders/:id/transition", handler: ({ ctx, params, body }) => transitionPurchaseOrder(ctx, params.id, z.object({ to: PurchaseOrderStatus.zod }).parse(body).to) },
  { method: "POST", path: "grns", handler: ({ ctx, body }) => createGRN(ctx, body as never) },
  { method: "POST", path: "grns/:id/post", handler: ({ ctx, params }) => postGRN(ctx, params.id) },
  { method: "POST", path: "bills", handler: ({ ctx, body }) => createPurchaseBill(ctx, body as never) },
  { method: "POST", path: "bills/:id/cancel", handler: ({ ctx, params }) => cancelPurchaseBill(ctx, params.id) },
  { method: "POST", path: "vendor-payments", handler: ({ ctx, body }) => payVendor(ctx, body as never) },
  {
    method: "GET", path: "vendor-dues",
    handler: ({ ctx, query }) => vendorDues(prisma, ctx, z.object({ outletId: z.string().optional(), vendorId: z.string().optional(), asOf: z.coerce.date().optional() }).parse(query)),
  },
]);
