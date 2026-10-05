/**
 * Master-data administration: units (+ conversions), material categories,
 * materials, vendors (+ vendor-material links), outlets, floors and tables.
 *
 * Authority:
 *  - Org-wide data (units, categories, materials, vendors) needs master.manage /
 *    vendor.manage held by an ORG-WIDE role — an outlet manager cannot change
 *    data every outlet depends on.
 *  - Outlets: create needs org.manage; contact details can be edited by the
 *    outlet's own manager (outlet.manage there); code / timezone / active need
 *    an org-wide role with outlet.manage (timezone moves business-day boundaries).
 *  - Floors and tables: outlet.manage at that outlet. Table status: outlet.manage
 *    or order.modify there (front-of-house marks tables clean/available).
 *
 * Invariants protected: a unit's code/kind cannot change once used; a unit
 * used as a base unit cannot be deactivated; a material's base unit cannot
 * change once stock has moved; SKU / codes stay unique. Every mutation audits.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { gstinSchema } from "@/domain/gst";
import { UnitKind, TableStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan, can, type Permission } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { isValidTimeZone } from "@/domain/time";
import { D, money } from "@/domain/money";
import { textContains } from "@/server/db/search";

function assertOrgWide(ctx: AccessContext, permission: Permission) {
  assertCan(ctx, permission);
  if (!ctx.isSuperAdmin && !ctx.isOrgWide) throw new ForbiddenError(`${permission} on organization-wide data needs an org-wide role`);
}

async function unique<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new ValidationError(message);
    throw e;
  }
}

function page<T extends { id: string }>(rows: T[], take: number) {
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

const pageQuery = z.object({ take: z.coerce.number().int().positive().max(200).default(50), cursor: z.string().optional() });

async function loadOrg<T extends { organizationId: string }>(row: T | null, ctx: AccessContext, what: string): Promise<T> {
  if (!row || row.organizationId !== ctx.organizationId) throw new NotFoundError(`${what} not found`);
  return row;
}

// ============================================================
// Units + conversions
// ============================================================

const unitSchema = z.object({ code: z.string().trim().min(1).max(12), name: z.string().trim().min(1).max(40), kind: UnitKind.zod });

export async function createUnit(ctx: AccessContext, input: z.input<typeof unitSchema>, db: Client = prisma) {
  const data = unitSchema.parse(input);
  assertOrgWide(ctx, "master.manage");
  return runInTx(db, async (tx) => {
    const unit = await unique(() => tx.unit.create({ data: { organizationId: ctx.organizationId, ...data } }), `Unit code "${data.code}" already exists`);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Unit", entityId: unit.id, after: data });
    return unit;
  });
}

async function unitInUse(tx: Tx, unitId: string) {
  const [materials, ledger, conversions] = await Promise.all([
    tx.material.count({ where: { baseUnitId: unitId } }),
    tx.inventoryLedger.count({ where: { unitId } }),
    tx.unitConversion.count({ where: { OR: [{ fromUnitId: unitId }, { toUnitId: unitId }] } }),
  ]);
  return materials + ledger + conversions > 0;
}

export async function updateUnit(ctx: AccessContext, unitId: string, patch: { code?: string; name?: string; kind?: string; active?: boolean }, db: Client = prisma) {
  const data = unitSchema.partial().extend({ active: z.boolean().optional() }).parse(patch);
  assertOrgWide(ctx, "master.manage");
  return runInTx(db, async (tx) => {
    const unit = await loadOrg(await tx.unit.findUnique({ where: { id: unitId } }), ctx, "Unit");
    const structural = (data.code !== undefined && data.code !== unit.code) || (data.kind !== undefined && data.kind !== unit.kind);
    if (structural && (await unitInUse(tx, unitId))) throw new ValidationError("A unit in use cannot change its code or kind (it would corrupt quantities)");
    if (data.active === false && (await tx.material.count({ where: { baseUnitId: unitId, active: true } }))) throw new ValidationError("Unit is the base unit of active materials");
    const updated = await unique(() => tx.unit.update({ where: { id: unitId }, data }), `Unit code "${data.code}" already exists`);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Unit", entityId: unitId, before: { code: unit.code, name: unit.name, kind: unit.kind, active: unit.active }, after: data });
    return updated;
  });
}

export function listUnits(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "master.view");
  return db.unit.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ kind: "asc" }, { code: "asc" }], take: 500 });
}

const conversionSchema = z.object({ fromUnitId: z.string(), toUnitId: z.string(), factor: z.number().positive().max(1_000_000), materialId: z.string().optional() });

/** 1 fromUnit = factor × toUnit. Global conversions must stay within one unit kind. */
export async function createUnitConversion(ctx: AccessContext, input: z.input<typeof conversionSchema>, db: Client = prisma) {
  const data = conversionSchema.parse(input);
  assertOrgWide(ctx, "master.manage");
  if (data.fromUnitId === data.toUnitId) throw new ValidationError("Conversion needs two different units");
  return runInTx(db, async (tx) => {
    const [from, to] = await Promise.all([tx.unit.findUnique({ where: { id: data.fromUnitId } }), tx.unit.findUnique({ where: { id: data.toUnitId } })]);
    await loadOrg(from, ctx, "Unit");
    await loadOrg(to, ctx, "Unit");
    if (data.materialId) await loadOrg(await tx.material.findUnique({ where: { id: data.materialId } }), ctx, "Material");
    else if (from!.kind !== to!.kind) throw new ValidationError("A global conversion must be between units of the same kind; use a material-specific conversion");
    const conv = await unique(
      () => tx.unitConversion.create({ data: { organizationId: ctx.organizationId, fromUnitId: data.fromUnitId, toUnitId: data.toUnitId, factor: D(data.factor), materialId: data.materialId ?? null } }),
      "This conversion already exists"
    );
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "UnitConversion", entityId: conv.id, after: data });
    return conv;
  });
}

// ============================================================
// Material categories + materials
// ============================================================

export async function createMaterialCategory(ctx: AccessContext, input: { name: string; parentId?: string }, db: Client = prisma) {
  const data = z.object({ name: z.string().trim().min(1).max(80), parentId: z.string().optional() }).parse(input);
  assertOrgWide(ctx, "master.manage");
  return runInTx(db, async (tx) => {
    if (data.parentId) await loadOrg(await tx.materialCategory.findUnique({ where: { id: data.parentId } }), ctx, "Parent category");
    const cat = await unique(() => tx.materialCategory.create({ data: { organizationId: ctx.organizationId, ...data } }), `Category "${data.name}" already exists`);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "MaterialCategory", entityId: cat.id, after: data });
    return cat;
  });
}

const materialSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  baseUnitId: z.string(),
  purchaseUnitId: z.string().optional(),
  categoryId: z.string().optional(),
  taxPct: z.number().min(0).max(28).default(0),
  minStock: z.number().nonnegative().default(0),
  reorderLevel: z.number().nonnegative().default(0),
  preferredVendorId: z.string().optional(),
  perishable: z.boolean().default(false),
  trackBatch: z.boolean().default(false),
});

async function assertMaterialRefs(tx: Tx, ctx: AccessContext, d: { baseUnitId?: string; purchaseUnitId?: string; categoryId?: string; preferredVendorId?: string }) {
  if (d.baseUnitId) {
    const u = await loadOrg(await tx.unit.findUnique({ where: { id: d.baseUnitId } }), ctx, "Base unit");
    if (!u.active) throw new ValidationError("Base unit is inactive");
  }
  if (d.purchaseUnitId) await loadOrg(await tx.unit.findUnique({ where: { id: d.purchaseUnitId } }), ctx, "Purchase unit");
  if (d.categoryId) await loadOrg(await tx.materialCategory.findUnique({ where: { id: d.categoryId } }), ctx, "Category");
  if (d.preferredVendorId) await loadOrg(await tx.vendor.findUnique({ where: { id: d.preferredVendorId } }), ctx, "Vendor");
}

export async function createMaterial(ctx: AccessContext, input: z.input<typeof materialSchema>, db: Client = prisma) {
  const data = materialSchema.parse(input);
  assertOrgWide(ctx, "master.manage");
  return runInTx(db, async (tx) => {
    await assertMaterialRefs(tx, ctx, data);
    const m = await unique(
      () => tx.material.create({ data: { organizationId: ctx.organizationId, ...data, taxPct: D(data.taxPct), minStock: D(data.minStock), reorderLevel: D(data.reorderLevel), createdById: ctx.userId === "system" ? null : ctx.userId } }),
      `SKU "${data.sku}" already exists`
    );
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Material", entityId: m.id, after: { sku: data.sku, name: data.name, baseUnitId: data.baseUnitId } });
    return m;
  });
}

export async function updateMaterial(ctx: AccessContext, materialId: string, patch: Partial<z.input<typeof materialSchema>> & { active?: boolean }, db: Client = prisma) {
  const data = materialSchema.partial().extend({ active: z.boolean().optional() }).parse(patch);
  assertOrgWide(ctx, "master.manage");
  return runInTx(db, async (tx) => {
    const m = await loadOrg(await tx.material.findUnique({ where: { id: materialId } }), ctx, "Material");
    if (data.baseUnitId && data.baseUnitId !== m.baseUnitId && (await tx.inventoryLedger.count({ where: { materialId } }))) {
      throw new ValidationError("Base unit cannot change after stock has moved (ledger quantities are in the base unit)");
    }
    await assertMaterialRefs(tx, ctx, data);
    const updated = await unique(
      () => tx.material.update({ where: { id: materialId }, data: { ...data, ...(data.taxPct !== undefined ? { taxPct: D(data.taxPct) } : {}), ...(data.minStock !== undefined ? { minStock: D(data.minStock) } : {}), ...(data.reorderLevel !== undefined ? { reorderLevel: D(data.reorderLevel) } : {}) } }),
      `SKU "${data.sku}" already exists`
    );
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Material", entityId: materialId, before: { sku: m.sku, name: m.name, active: m.active, baseUnitId: m.baseUnitId }, after: data });
    return updated;
  });
}

export async function listMaterials(db: PrismaClient, ctx: AccessContext, query: { search?: string; categoryId?: string; active?: boolean; take?: number; cursor?: string } = {}) {
  assertCan(ctx, "master.view");
  const q = pageQuery.extend({ search: z.string().max(100).optional(), categoryId: z.string().optional(), active: z.boolean().optional() }).parse(query);
  const rows = await db.material.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.active !== undefined ? { active: q.active } : {}),
      ...(q.search ? { OR: [{ name: textContains(q.search) }, { sku: textContains(q.search) }] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: q.take + 1,
    include: { baseUnit: { select: { code: true } }, category: { select: { name: true } } },
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  return page(rows, q.take);
}

export async function getMaterial(db: PrismaClient, ctx: AccessContext, materialId: string) {
  assertCan(ctx, "master.view");
  const m = await loadOrg(await db.material.findUnique({ where: { id: materialId }, include: { baseUnit: true, category: true, vendorLinks: true } }), ctx, "Material");
  // Lets the UI lock the base unit once it can no longer change (updateMaterial enforces it).
  const stockMoved = (await db.inventoryLedger.count({ where: { materialId, organizationId: ctx.organizationId }, take: 1 })) > 0;
  return { ...m, stockMoved };
}

// ============================================================
// Vendors + vendor-material links
// ============================================================

const vendorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  companyName: z.string().max(160).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().max(500).optional(),
  gstin: gstinSchema.optional(),
  bankAccount: z.string().regex(/^[0-9]{6,20}$/, "Bank account must be 6-20 digits").optional(),
  bankIfsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC").optional(),
  paymentTerms: z.string().max(20).optional(),
  creditLimit: z.number().nonnegative().default(0),
  notes: z.string().max(1000).optional(),
});

/** Bank details are only visible to vendor managers. */
function maskVendor<T extends { bankAccount: string | null; bankIfsc: string | null }>(ctx: AccessContext, v: T): T {
  if (can(ctx, "vendor.manage")) return v;
  return { ...v, bankAccount: v.bankAccount ? `••••${v.bankAccount.slice(-4)}` : null, bankIfsc: v.bankIfsc ? "••••" : null };
}

export async function createVendor(ctx: AccessContext, input: z.input<typeof vendorSchema>, db: Client = prisma) {
  const data = vendorSchema.parse(input);
  assertOrgWide(ctx, "vendor.manage");
  return runInTx(db, async (tx) => {
    const v = await unique(() => tx.vendor.create({ data: { organizationId: ctx.organizationId, ...data, creditLimit: money(data.creditLimit), createdById: ctx.userId === "system" ? null : ctx.userId } }), `Vendor "${data.name}" already exists`);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Vendor", entityId: v.id, after: { name: data.name, gstin: data.gstin } });
    return v;
  });
}

export async function updateVendor(ctx: AccessContext, vendorId: string, patch: Partial<z.input<typeof vendorSchema>> & { active?: boolean }, db: Client = prisma) {
  const data = vendorSchema.partial().extend({ active: z.boolean().optional() }).parse(patch);
  assertOrgWide(ctx, "vendor.manage");
  return runInTx(db, async (tx) => {
    const v = await loadOrg(await tx.vendor.findUnique({ where: { id: vendorId } }), ctx, "Vendor");
    const updated = await unique(() => tx.vendor.update({ where: { id: vendorId }, data: { ...data, ...(data.creditLimit !== undefined ? { creditLimit: money(data.creditLimit) } : {}) } }), `Vendor "${data.name}" already exists`);
    // Bank changes are a classic fraud vector: audit them without storing the full numbers.
    const bankChanged = data.bankAccount !== undefined && data.bankAccount !== v.bankAccount;
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Vendor", entityId: vendorId, before: { name: v.name, active: v.active }, after: { ...data, bankAccount: bankChanged ? `changed to ••••${data.bankAccount!.slice(-4)}` : undefined } });
    return updated;
  });
}

const linkSchema = z.object({ vendorId: z.string(), materialId: z.string(), lastRate: z.number().nonnegative().optional(), leadTimeDays: z.number().int().min(0).max(365).optional(), preferred: z.boolean().optional() });

/** Upsert a vendor-material link; `preferred` makes this the single preferred vendor for the material. */
export async function linkVendorMaterial(ctx: AccessContext, input: z.input<typeof linkSchema>, db: Client = prisma) {
  const data = linkSchema.parse(input);
  assertOrgWide(ctx, "vendor.manage");
  return runInTx(db, async (tx) => {
    const vendor = await loadOrg(await tx.vendor.findUnique({ where: { id: data.vendorId } }), ctx, "Vendor");
    await loadOrg(await tx.material.findUnique({ where: { id: data.materialId } }), ctx, "Material");
    if (!vendor.active) throw new ValidationError("Vendor is inactive");
    if (data.preferred) {
      await tx.vendorMaterial.updateMany({ where: { materialId: data.materialId, preferred: true }, data: { preferred: false } });
      await tx.material.update({ where: { id: data.materialId }, data: { preferredVendorId: data.vendorId } });
    }
    const fields = { ...(data.lastRate !== undefined ? { lastRate: money(data.lastRate) } : {}), ...(data.leadTimeDays !== undefined ? { leadTimeDays: data.leadTimeDays } : {}), ...(data.preferred !== undefined ? { preferred: data.preferred } : {}) };
    const link = await tx.vendorMaterial.upsert({
      where: { vendorId_materialId: { vendorId: data.vendorId, materialId: data.materialId } },
      create: { organizationId: ctx.organizationId, vendorId: data.vendorId, materialId: data.materialId, ...fields },
      update: fields,
    });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "VendorMaterial", entityId: link.id, after: data });
    return link;
  });
}

export async function listVendors(db: PrismaClient, ctx: AccessContext, query: { search?: string; active?: boolean; take?: number; cursor?: string } = {}) {
  assertCan(ctx, "vendor.view");
  const q = pageQuery.extend({ search: z.string().max(100).optional(), active: z.boolean().optional() }).parse(query);
  const rows = await db.vendor.findMany({
    where: { organizationId: ctx.organizationId, ...(q.active !== undefined ? { active: q.active } : {}), ...(q.search ? { OR: [{ name: textContains(q.search) }, { phone: textContains(q.search) }, { gstin: textContains(q.search) }] } : {}) },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: q.take + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const p = page(rows, q.take);
  return { ...p, items: p.items.map((v) => maskVendor(ctx, v)) };
}

export async function getVendor(db: PrismaClient, ctx: AccessContext, vendorId: string) {
  assertCan(ctx, "vendor.view");
  const v = await loadOrg(await db.vendor.findUnique({ where: { id: vendorId }, include: { materials: { include: { material: { select: { sku: true, name: true } } } } } }), ctx, "Vendor");
  return maskVendor(ctx, v);
}

// ============================================================
// Outlets
// ============================================================

const tz = z.string().refine(isValidTimeZone, "Unknown IANA timezone");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");
const outletSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  address: z.string().max(500).optional(),
  gstin: gstinSchema.optional(),
  phone: z.string().max(20).optional(),
  currency: z.string().length(3).default("INR"),
  timezone: tz.default("Asia/Kolkata"),
  openTime: hhmm.optional(),
  closeTime: hhmm.optional(),
  /** Invoice number prefix (1–4 letters/digits); default: from the outlet code. */
  invoiceSeries: z.string().trim().regex(/^[A-Z0-9]{1,4}$/, "Invoice series: 1–4 capital letters or digits").optional(),
});

export async function createOutlet(ctx: AccessContext, input: z.input<typeof outletSchema>, db: Client = prisma) {
  const data = outletSchema.parse(input);
  assertCan(ctx, "org.manage");
  return runInTx(db, async (tx) => {
    const outlet = await unique(() => tx.outlet.create({ data: { organizationId: ctx.organizationId, ...data } }), `Outlet code "${data.code}" already exists`);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Outlet", entityId: outlet.id, outletId: outlet.id, after: data });
    return outlet;
  });
}

export async function updateOutlet(ctx: AccessContext, outletId: string, patch: Partial<z.input<typeof outletSchema>> & { active?: boolean }, db: Client = prisma) {
  const data = outletSchema.partial().extend({ active: z.boolean().optional() }).parse(patch);
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "outlet.manage", outletId);
  // Tax identity (GSTIN, invoice series) is structural too: it changes every invoice issued afterwards.
  const structural = data.code !== undefined || data.timezone !== undefined || data.active !== undefined || data.currency !== undefined || data.gstin !== undefined || data.invoiceSeries !== undefined;
  if (structural && !ctx.isSuperAdmin && !ctx.isOrgWide) throw new ForbiddenError("Changing an outlet's code, timezone, currency, status, GSTIN or invoice series needs an org-wide role");
  return runInTx(db, async (tx) => {
    const o = await loadOrg(await tx.outlet.findUnique({ where: { id: outletId } }), ctx, "Outlet");
    const updated = await unique(() => tx.outlet.update({ where: { id: outletId }, data }), `Outlet code "${data.code}" already exists`);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Outlet", entityId: outletId, outletId, before: { code: o.code, name: o.name, timezone: o.timezone, active: o.active, gstin: o.gstin, invoiceSeries: o.invoiceSeries }, after: data });
    return updated;
  });
}

export async function listOutlets(db: PrismaClient, ctx: AccessContext) {
  return db.outlet.findMany({
    where: { organizationId: ctx.organizationId, ...(ctx.isOrgWide || ctx.isSuperAdmin ? {} : { id: { in: ctx.outletIds } }) },
    orderBy: [{ code: "asc" }],
    take: 500,
  });
}

// ============================================================
// Floors + tables
// ============================================================

function assertOutletManager(ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "outlet.manage", outletId);
}

async function outletInOrg(tx: Tx, ctx: AccessContext, outletId: string) {
  return loadOrg(await tx.outlet.findUnique({ where: { id: outletId } }), ctx, "Outlet");
}

export async function createFloor(ctx: AccessContext, input: { outletId: string; name: string; sortOrder?: number }, db: Client = prisma) {
  const data = z.object({ outletId: z.string(), name: z.string().trim().min(1).max(60), sortOrder: z.number().int().default(0) }).parse(input);
  assertOutletManager(ctx, data.outletId);
  return runInTx(db, async (tx) => {
    await outletInOrg(tx, ctx, data.outletId);
    const f = await unique(() => tx.floor.create({ data: { organizationId: ctx.organizationId, ...data } }), `Floor "${data.name}" already exists`);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Floor", entityId: f.id, outletId: data.outletId, after: data });
    return f;
  });
}

const tableSchema = z.object({ outletId: z.string(), code: z.string().trim().min(1).max(20), capacity: z.number().int().min(1).max(50).default(4), floorId: z.string().optional() });

async function assertFloor(tx: Tx, ctx: AccessContext, floorId: string | undefined | null, outletId: string) {
  if (!floorId) return;
  const floor = await tx.floor.findUnique({ where: { id: floorId } });
  if (!floor || floor.organizationId !== ctx.organizationId || floor.outletId !== outletId) throw new ValidationError("Floor not in this outlet");
}

export async function createTable(ctx: AccessContext, input: z.input<typeof tableSchema>, db: Client = prisma) {
  const data = tableSchema.parse(input);
  assertOutletManager(ctx, data.outletId);
  return runInTx(db, async (tx) => {
    await outletInOrg(tx, ctx, data.outletId);
    await assertFloor(tx, ctx, data.floorId, data.outletId);
    const t = await unique(() => tx.restaurantTable.create({ data: { organizationId: ctx.organizationId, ...data, status: "AVAILABLE" } }), `Table "${data.code}" already exists at this outlet`);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "RestaurantTable", entityId: t.id, outletId: data.outletId, after: data });
    return t;
  });
}

async function loadTable(tx: Tx, ctx: AccessContext, tableId: string) {
  return loadOrg(await tx.restaurantTable.findUnique({ where: { id: tableId } }), ctx, "Table");
}

export async function updateTable(ctx: AccessContext, tableId: string, patch: { code?: string; capacity?: number; floorId?: string | null }, db: Client = prisma) {
  const data = z.object({ code: z.string().trim().min(1).max(20).optional(), capacity: z.number().int().min(1).max(50).optional(), floorId: z.string().nullable().optional() }).parse(patch);
  return runInTx(db, async (tx) => {
    const t = await loadTable(tx, ctx, tableId);
    assertOutletManager(ctx, t.outletId);
    await assertFloor(tx, ctx, data.floorId, t.outletId);
    if (data.capacity !== undefined && data.capacity < t.capacity) {
      const bigger = await tx.reservation.findFirst({ where: { tableId, status: { in: ["BOOKED", "CONFIRMED", "SEATED"] }, partySize: { gt: data.capacity } } });
      if (bigger) throw new ValidationError(`An active reservation for ${bigger.partySize} needs this table's capacity`);
    }
    const updated = await unique(() => tx.restaurantTable.update({ where: { id: tableId }, data }), `Table "${data.code}" already exists at this outlet`);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "RestaurantTable", entityId: tableId, outletId: t.outletId, before: { code: t.code, capacity: t.capacity, floorId: t.floorId }, after: data });
    return updated;
  });
}

/** Operational status change (e.g. CLEANING -> AVAILABLE). Cannot free a table with a running order. */
export async function setTableStatus(ctx: AccessContext, tableId: string, status: string, db: Client = prisma) {
  const to = TableStatus.zod.parse(status);
  return runInTx(db, async (tx) => {
    const t = await loadTable(tx, ctx, tableId);
    assertOutletAccess(ctx, t.outletId);
    if (!can(ctx, "outlet.manage", t.outletId) && !can(ctx, "order.modify", t.outletId)) throw new ForbiddenError("Missing permission to change table status");
    if (to === "AVAILABLE" && (await tx.order.count({ where: { tableId, status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] } } }))) throw new ValidationError("Table has an active order");
    const updated = await tx.restaurantTable.update({ where: { id: tableId }, data: { status: to } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "RestaurantTable", entityId: tableId, outletId: t.outletId, before: { status: t.status }, after: { status: to } });
    return updated;
  });
}

/** Issue (or rotate) the table's QR token; the previous token stops working immediately. */
export async function rotateTableQr(ctx: AccessContext, tableId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const t = await loadTable(tx, ctx, tableId);
    assertOutletManager(ctx, t.outletId);
    const qrToken = randomBytes(18).toString("base64url");
    const updated = await tx.restaurantTable.update({ where: { id: tableId }, data: { qrToken } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "RestaurantTable", entityId: tableId, outletId: t.outletId, after: { qrRotated: true } });
    return updated;
  });
}

export async function listTables(db: PrismaClient, ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  if (!can(ctx, "order.view", outletId) && !can(ctx, "reservation.manage", outletId) && !can(ctx, "outlet.manage", outletId)) throw new ForbiddenError("Missing permission to view tables");
  return db.restaurantTable.findMany({ where: { organizationId: ctx.organizationId, outletId }, orderBy: [{ code: "asc" }], take: 500, include: { floor: { select: { name: true } } } });
}
