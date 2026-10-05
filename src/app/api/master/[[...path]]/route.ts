import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, outletQuery } from "@/server/api/router";
import {
  createUnit, updateUnit, listUnits, createUnitConversion, createMaterialCategory,
  createMaterial, updateMaterial, listMaterials, getMaterial,
  createVendor, updateVendor, listVendors, getVendor, linkVendorMaterial,
  createOutlet, updateOutlet, listOutlets,
  createFloor, createTable, updateTable, setTableStatus, rotateTableQr, listTables,
} from "@/server/services/masterData";
import {
  getOrganization, updateOrganization, listDepartments, createDepartment, updateDepartment,
  listFloors, updateFloor, listUnitConversions, listMaterialCategories,
} from "@/server/services/adminQueries";
import { listIntegrations, upsertIntegration } from "@/server/services/integrations";

export const runtime = "nodejs";

const bool = z.enum(["true", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "true"));
const pageQ = z.object({ take: z.coerce.number().int().positive().max(200).optional(), cursor: z.string().optional(), search: z.string().max(100).optional(), active: bool });

export const { GET, POST, PATCH } = createRouter([
  // organization
  { method: "GET", path: "organization", handler: ({ ctx }) => getOrganization(prisma, ctx) },
  { method: "PATCH", path: "organization", reauth: "settings.manage", handler: ({ ctx, body }) => updateOrganization(ctx, body as never) },
  // departments (outlet-level)
  { method: "GET", path: "departments", handler: ({ ctx, query }) => listDepartments(prisma, ctx, outletQuery.parse(query).outletId) },
  { method: "POST", path: "departments", handler: ({ ctx, body }) => createDepartment(ctx, body as never) },
  { method: "PATCH", path: "departments/:id", handler: ({ ctx, params, body }) => updateDepartment(ctx, params.id, body as never) },
  // units
  { method: "GET", path: "unit-conversions", handler: ({ ctx }) => listUnitConversions(prisma, ctx) },
  { method: "GET", path: "material-categories", handler: ({ ctx }) => listMaterialCategories(prisma, ctx) },
  { method: "GET", path: "units", handler: ({ ctx }) => listUnits(prisma, ctx) },
  { method: "POST", path: "units", handler: ({ ctx, body }) => createUnit(ctx, body as never) },
  { method: "PATCH", path: "units/:id", handler: ({ ctx, params, body }) => updateUnit(ctx, params.id, body as never) },
  { method: "POST", path: "unit-conversions", handler: ({ ctx, body }) => createUnitConversion(ctx, body as never) },
  // materials
  { method: "POST", path: "material-categories", handler: ({ ctx, body }) => createMaterialCategory(ctx, body as never) },
  { method: "GET", path: "materials", handler: ({ ctx, query }) => listMaterials(prisma, ctx, pageQ.extend({ categoryId: z.string().optional() }).parse(query)) },
  { method: "POST", path: "materials", handler: ({ ctx, body }) => createMaterial(ctx, body as never) },
  { method: "GET", path: "materials/:id", handler: ({ ctx, params }) => getMaterial(prisma, ctx, params.id) },
  { method: "PATCH", path: "materials/:id", handler: ({ ctx, params, body }) => updateMaterial(ctx, params.id, body as never) },
  // vendors
  { method: "GET", path: "vendors", handler: ({ ctx, query }) => listVendors(prisma, ctx, pageQ.parse(query)) },
  { method: "POST", path: "vendors", handler: ({ ctx, body }) => createVendor(ctx, body as never) },
  { method: "GET", path: "vendors/:id", handler: ({ ctx, params }) => getVendor(prisma, ctx, params.id) },
  { method: "PATCH", path: "vendors/:id", handler: ({ ctx, params, body }) => updateVendor(ctx, params.id, body as never) },
  { method: "POST", path: "vendors/:id/materials", handler: ({ ctx, params, body }) => linkVendorMaterial(ctx, { ...(body as object), vendorId: params.id } as never) },
  // outlets
  { method: "GET", path: "outlets", handler: ({ ctx }) => listOutlets(prisma, ctx) },
  { method: "POST", path: "outlets", reauth: "settings.manage", handler: ({ ctx, body }) => createOutlet(ctx, body as never) },
  { method: "PATCH", path: "outlets/:id", reauth: "settings.manage", handler: ({ ctx, params, body }) => updateOutlet(ctx, params.id, body as never) },
  // integration connections (webhook tenant binding; secrets are write-only)
  { method: "GET", path: "integrations", handler: ({ ctx }) => listIntegrations(prisma, ctx) },
  { method: "POST", path: "integrations", reauth: "settings.manage", handler: ({ ctx, body }) => upsertIntegration(ctx, body as never) },
  // floors + tables
  { method: "GET", path: "floors", handler: ({ ctx, query }) => listFloors(prisma, ctx, outletQuery.parse(query).outletId) },
  { method: "PATCH", path: "floors/:id", handler: ({ ctx, params, body }) => updateFloor(ctx, params.id, body as never) },
  { method: "POST", path: "floors", handler: ({ ctx, body }) => createFloor(ctx, body as never) },
  { method: "GET", path: "tables", handler: ({ ctx, query }) => listTables(prisma, ctx, outletQuery.parse(query).outletId) },
  { method: "POST", path: "tables", handler: ({ ctx, body }) => createTable(ctx, body as never) },
  { method: "PATCH", path: "tables/:id", handler: ({ ctx, params, body }) => updateTable(ctx, params.id, body as never) },
  { method: "POST", path: "tables/:id/status", handler: ({ ctx, params, body }) => setTableStatus(ctx, params.id, z.object({ status: z.string() }).parse(body).status) },
  { method: "POST", path: "tables/:id/qr", handler: ({ ctx, params }) => rotateTableQr(ctx, params.id) },
]);
