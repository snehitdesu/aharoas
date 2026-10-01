/**
 * Menu domain service: categories, items, variants, modifier groups/options,
 * availability, and server-side pricing of a menu selection.
 *
 * Scope: the menu itself is organization-wide (MenuItem), so structural menu
 * mutations require `menu.manage` held by an org-wide role. Each outlet can
 * override an item's price, whether it is offered, and sold-out state through
 * OutletMenuItem — that needs `menu.manage` at that outlet only, so an outlet
 * manager can 86 a dish at their outlet without affecting the others.
 *
 * Pricing is authoritative here: `priceMenuSelection` derives the unit price
 * (item price + variant delta) and the modifiers (from configured options,
 * enforcing each group's min/max) — the order service uses it instead of
 * trusting client-supplied prices.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { Station } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { D, money, num } from "@/domain/money";

const price = z.number().nonnegative().max(1_000_000);
const delta = z.number().min(-1_000_000).max(1_000_000);

function assertMenuManager(ctx: AccessContext) {
  assertCan(ctx, "menu.manage");
  if (!ctx.isSuperAdmin && !ctx.isOrgWide) throw new ForbiddenError("The menu is organization-wide; changes need an org-wide role with menu.manage");
}

async function unique<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code === "P2002") throw new ValidationError(message);
    throw e;
  }
}

async function loadItem(tx: Tx | PrismaClient, ctx: AccessContext, menuItemId: string) {
  const item = await tx.menuItem.findUnique({ where: { id: menuItemId } });
  if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Menu item not found");
  return item;
}

async function loadGroup(tx: Tx, ctx: AccessContext, groupId: string) {
  const group = await tx.modifierGroup.findUnique({ where: { id: groupId } });
  if (!group || group.organizationId !== ctx.organizationId) throw new NotFoundError("Modifier group not found");
  return group;
}

// ---------------- Categories ----------------

const categorySchema = z.object({ name: z.string().trim().min(1).max(80), sortOrder: z.number().int().default(0) });

export async function createMenuCategory(ctx: AccessContext, input: z.input<typeof categorySchema>, db: Client = prisma) {
  const data = categorySchema.parse(input);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const cat = await unique(() => tx.menuCategory.create({ data: { organizationId: ctx.organizationId, ...data } }), "A category with this name already exists");
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "MenuCategory", entityId: cat.id, after: data });
    return cat;
  });
}

export async function updateMenuCategory(ctx: AccessContext, categoryId: string, patch: { name?: string; sortOrder?: number; active?: boolean }, db: Client = prisma) {
  const data = categorySchema.partial().extend({ active: z.boolean().optional() }).parse(patch);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const cat = await tx.menuCategory.findUnique({ where: { id: categoryId } });
    if (!cat || cat.organizationId !== ctx.organizationId) throw new NotFoundError("Category not found");
    const updated = await unique(() => tx.menuCategory.update({ where: { id: categoryId }, data }), "A category with this name already exists");
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "MenuCategory", entityId: categoryId, before: { name: cat.name, active: cat.active }, after: data });
    return updated;
  });
}

// ---------------- Items ----------------

const itemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: z.string().optional(),
  description: z.string().max(1000).optional(),
  price,
  taxPct: z.number().min(0).max(28).default(5),
  station: Station.zod.default("KITCHEN"),
  posCode: z.string().trim().min(1).max(64).optional(),
  isVeg: z.boolean().default(true),
});

async function assertCategory(tx: Tx, ctx: AccessContext, categoryId?: string | null) {
  if (!categoryId) return;
  const cat = await tx.menuCategory.findUnique({ where: { id: categoryId } });
  if (!cat || cat.organizationId !== ctx.organizationId) throw new NotFoundError("Category not found");
}

async function assertPosCodeFree(tx: Tx, ctx: AccessContext, posCode: string | undefined, exceptId?: string) {
  if (!posCode) return;
  const clash = await tx.menuItem.findFirst({ where: { organizationId: ctx.organizationId, posCode, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (clash) throw new ValidationError(`POS code ${posCode} is already mapped to "${clash.name}"`);
}

export async function createMenuItem(ctx: AccessContext, input: z.input<typeof itemSchema>, db: Client = prisma) {
  const data = itemSchema.parse(input);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    await assertCategory(tx, ctx, data.categoryId);
    await assertPosCodeFree(tx, ctx, data.posCode);
    const item = await unique(() => tx.menuItem.create({ data: { organizationId: ctx.organizationId, ...data, price: money(data.price), taxPct: D(data.taxPct), createdById: ctx.userId === "system" ? null : ctx.userId } }), "A menu item with this name already exists");
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "MenuItem", entityId: item.id, after: { name: data.name, price: data.price, posCode: data.posCode } });
    return item;
  });
}

export async function updateMenuItem(ctx: AccessContext, menuItemId: string, patch: Partial<z.input<typeof itemSchema>>, db: Client = prisma) {
  const data = itemSchema.partial().parse(patch);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const before = await loadItem(tx, ctx, menuItemId);
    if (data.categoryId !== undefined) await assertCategory(tx, ctx, data.categoryId);
    await assertPosCodeFree(tx, ctx, data.posCode, menuItemId);
    const updated = await unique(
      () => tx.menuItem.update({ where: { id: menuItemId }, data: { ...data, ...(data.price !== undefined ? { price: money(data.price) } : {}), ...(data.taxPct !== undefined ? { taxPct: D(data.taxPct) } : {}) } }),
      "A menu item with this name already exists"
    );
    const priceChanged = data.price !== undefined && !D(before.price).eq(D(data.price));
    await writeAudit(tx, ctx, { action: priceChanged ? "PRICE_CHANGE" : "UPDATE", entityType: "MenuItem", entityId: menuItemId, before: { name: before.name, price: num(before.price), taxPct: num(before.taxPct) }, after: data });
    return updated;
  });
}

/** Availability: `active` (on the menu at all) and `soldOut` (temporarily unavailable). */
export async function setMenuItemAvailability(ctx: AccessContext, menuItemId: string, input: { active?: boolean; soldOut?: boolean }, db: Client = prisma) {
  const data = z.object({ active: z.boolean().optional(), soldOut: z.boolean().optional() }).refine((d) => d.active !== undefined || d.soldOut !== undefined, "Nothing to change").parse(input);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const before = await loadItem(tx, ctx, menuItemId);
    const updated = await tx.menuItem.update({ where: { id: menuItemId }, data });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "MenuItem", entityId: menuItemId, before: { active: before.active, soldOut: before.soldOut }, after: data });
    return updated;
  });
}

// ---------------- Variants ----------------

export async function addVariant(ctx: AccessContext, input: { menuItemId: string; name: string; priceDelta: number }, db: Client = prisma) {
  const data = z.object({ menuItemId: z.string(), name: z.string().trim().min(1).max(60), priceDelta: delta }).parse(input);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const item = await loadItem(tx, ctx, data.menuItemId);
    if (D(item.price).plus(data.priceDelta).lt(0)) throw new ValidationError("Variant price would be negative");
    const v = await unique(() => tx.menuItemVariant.create({ data: { organizationId: ctx.organizationId, menuItemId: data.menuItemId, name: data.name, priceDelta: money(data.priceDelta) } }), "Variant already exists on this item");
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "MenuItemVariant", entityId: v.id, after: data });
    return v;
  });
}

export async function updateVariant(ctx: AccessContext, variantId: string, patch: { priceDelta?: number; active?: boolean }, db: Client = prisma) {
  const data = z.object({ priceDelta: delta.optional(), active: z.boolean().optional() }).parse(patch);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const v = await tx.menuItemVariant.findUnique({ where: { id: variantId }, include: { menuItem: true } });
    if (!v || v.organizationId !== ctx.organizationId) throw new NotFoundError("Variant not found");
    if (data.priceDelta !== undefined && D(v.menuItem.price).plus(data.priceDelta).lt(0)) throw new ValidationError("Variant price would be negative");
    const updated = await tx.menuItemVariant.update({ where: { id: variantId }, data: { ...data, ...(data.priceDelta !== undefined ? { priceDelta: money(data.priceDelta) } : {}) } });
    await writeAudit(tx, ctx, { action: data.priceDelta !== undefined ? "PRICE_CHANGE" : "UPDATE", entityType: "MenuItemVariant", entityId: variantId, before: { priceDelta: num(v.priceDelta), active: v.active }, after: data });
    return updated;
  });
}

// ---------------- Modifier groups / options ----------------

const groupSchema = z.object({ name: z.string().trim().min(1).max(60), minSelect: z.number().int().min(0).default(0), maxSelect: z.number().int().min(1).default(1) }).refine((g) => g.minSelect <= g.maxSelect, "minSelect cannot exceed maxSelect");

export async function createModifierGroup(ctx: AccessContext, input: z.input<typeof groupSchema>, db: Client = prisma) {
  const data = groupSchema.parse(input);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const g = await unique(() => tx.modifierGroup.create({ data: { organizationId: ctx.organizationId, ...data } }), "A modifier group with this name already exists");
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "ModifierGroup", entityId: g.id, after: data });
    return g;
  });
}

const groupPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), minSelect: z.number().int().min(0).optional(), maxSelect: z.number().int().min(1).optional(), active: z.boolean().optional() }).strict();

/** Rename a group, change its selection rules, or retire it (inactive groups are skipped by pricing). */
export async function updateModifierGroup(ctx: AccessContext, groupId: string, patch: z.input<typeof groupPatch>, db: Client = prisma) {
  const data = groupPatch.parse(patch);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const g = await loadGroup(tx, ctx, groupId);
    const min = data.minSelect ?? g.minSelect;
    const max = data.maxSelect ?? g.maxSelect;
    if (min > max) throw new ValidationError("minSelect cannot exceed maxSelect");
    const updated = await unique(() => tx.modifierGroup.update({ where: { id: groupId }, data }), "A modifier group with this name already exists");
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "ModifierGroup", entityId: groupId, before: { name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, active: g.active }, after: data });
    return updated;
  });
}

export async function addModifierOption(ctx: AccessContext, input: { groupId: string; name: string; priceDelta?: number }, db: Client = prisma) {
  const data = z.object({ groupId: z.string(), name: z.string().trim().min(1).max(60), priceDelta: z.number().min(0).max(1_000_000).default(0) }).parse(input);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    await loadGroup(tx, ctx, data.groupId);
    const o = await unique(() => tx.modifierOption.create({ data: { organizationId: ctx.organizationId, groupId: data.groupId, name: data.name, priceDelta: money(data.priceDelta) } }), "Option already exists in this group");
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "ModifierOption", entityId: o.id, after: data });
    return o;
  });
}

export async function updateModifierOption(ctx: AccessContext, optionId: string, patch: { priceDelta?: number; active?: boolean }, db: Client = prisma) {
  const data = z.object({ priceDelta: z.number().min(0).max(1_000_000).optional(), active: z.boolean().optional() }).parse(patch);
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    const o = await tx.modifierOption.findUnique({ where: { id: optionId } });
    if (!o || o.organizationId !== ctx.organizationId) throw new NotFoundError("Modifier option not found");
    const updated = await tx.modifierOption.update({ where: { id: optionId }, data: { ...data, ...(data.priceDelta !== undefined ? { priceDelta: money(data.priceDelta) } : {}) } });
    await writeAudit(tx, ctx, { action: data.priceDelta !== undefined ? "PRICE_CHANGE" : "UPDATE", entityType: "ModifierOption", entityId: optionId, before: { priceDelta: num(o.priceDelta), active: o.active }, after: data });
    return updated;
  });
}

export async function attachModifierGroup(ctx: AccessContext, menuItemId: string, groupId: string, db: Client = prisma) {
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    await loadItem(tx, ctx, menuItemId);
    await loadGroup(tx, ctx, groupId);
    const link = await tx.menuItemModifierGroup.upsert({ where: { menuItemId_groupId: { menuItemId, groupId } }, create: { menuItemId, groupId }, update: {} });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "MenuItem", entityId: menuItemId, after: { attachedModifierGroup: groupId } });
    return link;
  });
}

export async function detachModifierGroup(ctx: AccessContext, menuItemId: string, groupId: string, db: Client = prisma) {
  assertMenuManager(ctx);
  return runInTx(db, async (tx) => {
    await loadItem(tx, ctx, menuItemId);
    const res = await tx.menuItemModifierGroup.deleteMany({ where: { menuItemId, groupId } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "MenuItem", entityId: menuItemId, after: { detachedModifierGroup: groupId } });
    return { detached: res.count };
  });
}

// ---------------- Per-outlet overrides ----------------

const overrideSchema = z.object({
  outletId: z.string(),
  menuItemId: z.string(),
  /** null clears the override (the org price applies again). */
  price: price.nullable().optional(),
  active: z.boolean().optional(),
  soldOut: z.boolean().optional(),
});

/** Set an outlet's price / offered / sold-out override for one item. */
export async function setOutletMenuItem(ctx: AccessContext, input: z.input<typeof overrideSchema>, db: Client = prisma) {
  const data = overrideSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "menu.manage", data.outletId);
  return runInTx(db, async (tx) => {
    const outlet = await tx.outlet.findUnique({ where: { id: data.outletId }, select: { organizationId: true } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
    await loadItem(tx, ctx, data.menuItemId);
    const before = await tx.outletMenuItem.findUnique({ where: { outletId_menuItemId: { outletId: data.outletId, menuItemId: data.menuItemId } } });
    const patch = {
      ...(data.price !== undefined ? { price: data.price === null ? null : money(data.price) } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.soldOut !== undefined ? { soldOut: data.soldOut } : {}),
    };
    const row = await tx.outletMenuItem.upsert({
      where: { outletId_menuItemId: { outletId: data.outletId, menuItemId: data.menuItemId } },
      create: { organizationId: ctx.organizationId, outletId: data.outletId, menuItemId: data.menuItemId, ...patch },
      update: patch,
    });
    await writeAudit(tx, ctx, {
      action: data.price !== undefined ? "PRICE_CHANGE" : "UPDATE", entityType: "OutletMenuItem", entityId: row.id, outletId: data.outletId,
      before: before ? { price: before.price === null ? null : num(before.price), active: before.active, soldOut: before.soldOut } : null, after: data,
    });
    return row;
  });
}

// ---------------- Reads ----------------

/**
 * The menu with categories, variants and modifier groups. With `outletId`, each
 * item carries its effective price / offered / soldOut at that outlet.
 * `activeOnly` hides inactive items/options (and, with an outlet, items not offered there).
 */
export async function listMenu(db: PrismaClient, ctx: AccessContext, opts: { activeOnly?: boolean; categoryId?: string; outletId?: string } = {}) {
  assertCan(ctx, "menu.view", opts.outletId);
  if (opts.outletId) assertOutletAccess(ctx, opts.outletId);
  const active = opts.activeOnly ? { active: true } : {};
  const items = await db.menuItem.findMany({
    where: { organizationId: ctx.organizationId, ...active, ...(opts.categoryId ? { categoryId: opts.categoryId } : {}) },
    orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    take: 1000,
    include: {
      category: { select: { id: true, name: true, sortOrder: true } },
      variants: { where: active, orderBy: { name: "asc" } },
      modifierGroups: { include: { group: { include: { options: { where: active, orderBy: { name: "asc" } } } } } },
      ...(opts.outletId ? { outletOverrides: { where: { outletId: opts.outletId } } } : {}),
    },
  });
  if (!opts.outletId) return items;
  const effective = items.map((item) => {
    const o = (item as typeof item & { outletOverrides?: Array<{ price: unknown; active: boolean; soldOut: boolean }> }).outletOverrides?.[0];
    return { ...item, effectivePrice: num(o?.price !== null && o?.price !== undefined ? (o.price as never) : item.price), offered: item.active && (o?.active ?? true), effectiveSoldOut: item.soldOut || (o?.soldOut ?? false) };
  });
  return opts.activeOnly ? effective.filter((i) => i.offered) : effective;
}

export function listMenuCategories(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "menu.view");
  return db.menuCategory.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

// ---------------- Pricing ----------------

export type PricedSelection = {
  menuItemId: string;
  name: string;
  unitPrice: ReturnType<typeof D>;
  taxPct: ReturnType<typeof D>;
  station: string;
  /** Per-unit modifier deltas from configured options. */
  modifiers: Array<{ name: string; priceDelta: ReturnType<typeof D> }>;
};

/**
 * Validate a menu selection and price it from the menu: item must be active and
 * not sold out; the variant must belong to the item; options must be active,
 * belong to groups attached to the item, and satisfy each group's min/max.
 */
export async function priceMenuSelection(tx: Tx, ctx: AccessContext, input: { menuItemId: string; variantId?: string; modifierOptionIds?: string[]; outletId?: string }): Promise<PricedSelection> {
  const item = await tx.menuItem.findUnique({
    where: { id: input.menuItemId },
    include: { variants: true, modifierGroups: { include: { group: { include: { options: true } } } } },
  });
  if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Menu item not found");
  if (!item.active) throw new ValidationError(`${item.name} is not on the menu`);
  if (item.soldOut) throw new ValidationError(`${item.name} is sold out`);
  const override = input.outletId ? await tx.outletMenuItem.findUnique({ where: { outletId_menuItemId: { outletId: input.outletId, menuItemId: item.id } } }) : null;
  if (override && !override.active) throw new ValidationError(`${item.name} is not offered at this outlet`);
  if (override?.soldOut) throw new ValidationError(`${item.name} is sold out at this outlet`);

  let unitPrice = override?.price !== null && override?.price !== undefined ? D(override.price) : D(item.price);
  let name = item.name;
  if (input.variantId) {
    const v = item.variants.find((x) => x.id === input.variantId);
    if (!v || !v.active) throw new ValidationError("Variant is not available for this item");
    unitPrice = unitPrice.plus(D(v.priceDelta));
    name = `${item.name} (${v.name})`;
  }

  const chosen = new Set(input.modifierOptionIds ?? []);
  if (chosen.size !== (input.modifierOptionIds ?? []).length) throw new ValidationError("Duplicate modifier options");
  const modifiers: PricedSelection["modifiers"] = [];
  for (const { group } of item.modifierGroups) {
    if (!group.active) continue;
    const picked = group.options.filter((o) => chosen.has(o.id));
    for (const o of picked) {
      if (!o.active) throw new ValidationError(`${o.name} is not available`);
      chosen.delete(o.id);
      modifiers.push({ name: `${group.name}: ${o.name}`, priceDelta: D(o.priceDelta) });
    }
    if (picked.length < group.minSelect) throw new ValidationError(`${group.name}: choose at least ${group.minSelect}`);
    if (picked.length > group.maxSelect) throw new ValidationError(`${group.name}: choose at most ${group.maxSelect}`);
  }
  if (chosen.size) throw new ValidationError("Modifier option is not offered for this item");
  return { menuItemId: item.id, name, unitPrice: money(unitPrice), taxPct: D(item.taxPct), station: item.station, modifiers };
}
