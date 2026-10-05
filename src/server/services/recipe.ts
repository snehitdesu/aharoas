/**
 * Recipe domain service.
 *
 * - Recipes are versioned; explosion/costing always run against a specific
 *   RecipeVersion. The "active" version is the APPROVED one with the latest
 *   effectiveFrom that has passed; drafts are never consumed.
 * - explodeRecipe expands a recipe to its raw-material requirements, recursing
 *   through sub-recipes, applying yield scaling, per-line wastage and unit
 *   conversion. Cycles are rejected at runtime (RecipeCycleError) as a
 *   belt-and-braces guard on top of write-time validation.
 * - calculateRecipeCost prices the exploded materials at an outlet's
 *   weighted-average cost.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { RECIPE_VERSION_TRANSITIONS, RecipeComponentType, RecipeOutputType, canTransition, type RecipeStatus } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, ValidationError, NotFoundError, ForbiddenError, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { runInTx } from "@/server/services/_workflow";
import { D, dMul, dDiv, qty as roundQty, money, num } from "@/domain/money";
import { RecipeCycleError, findCycleOnAdd, type RecipeGraph } from "@/domain/recipe/cycle";
import { textContains } from "@/server/db/search";
import { resolveUnit } from "@/server/services/inventory";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

const MAX_DEPTH = 20;

/** Convert a quantity expressed in `fromUnitId` into the material's base unit. */
export async function convertToBase(
  db: Client,
  ctx: AccessContext,
  materialId: string,
  quantity: Prisma.Decimal,
  fromUnitId?: string | null
): Promise<Prisma.Decimal> {
  const material = await db.material.findUnique({ where: { id: materialId } });
  if (!material || material.organizationId !== ctx.organizationId) throw new NotFoundError("Material not found");
  // One conversion rule for the whole system (inventory.resolveUnit).
  const { factor } = await resolveUnit(db, ctx, materialId, fromUnitId);
  return dMul(quantity, factor);
}

/**
 * The version to use for explosion/costing at time `at` (default now): the
 * APPROVED version with the latest effectiveFrom <= at (ties -> higher version).
 * Drafts are never used for consumption. Throws if the recipe has no version in effect.
 */
export async function getActiveVersion(db: Client, ctx: AccessContext, recipeId: string, at: Date = new Date()) {
  const active = await findActiveVersion(db, ctx, recipeId, at);
  if (!active) throw new ValidationError(`Recipe ${recipeId} has no approved version in effect`);
  return active;
}

function findActiveVersion(db: Client, ctx: AccessContext, recipeId: string, at: Date = new Date()) {
  return db.recipeVersion.findFirst({
    where: { organizationId: ctx.organizationId, recipeId, status: "APPROVED", effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });
}

/** Active version for a menu item's recipe, or null (=> the sale is recorded as unmapped). */
export async function getActiveVersionForMenuItem(db: Client, ctx: AccessContext, menuItemId: string, at: Date = new Date()) {
  const recipe = await db.recipe.findFirst({ where: { organizationId: ctx.organizationId, menuItemId, active: true } });
  if (!recipe) return null;
  return findActiveVersion(db, ctx, recipe.id, at);
}

export type ExplosionResult = Map<string, Prisma.Decimal>; // materialId -> qty in base unit

/**
 * Expand a recipe version to raw-material requirements for producing `quantity`
 * of the recipe's output.
 */
export async function explodeRecipe(
  db: Client,
  ctx: AccessContext,
  recipeVersionId: string,
  quantity: Prisma.Decimal | number | string,
  _path: string[] = []
): Promise<ExplosionResult> {
  const result: ExplosionResult = new Map();
  await explodeInto(db, ctx, recipeVersionId, D(quantity), result, _path);
  return result;
}

async function explodeInto(
  db: Client,
  ctx: AccessContext,
  recipeVersionId: string,
  quantity: Prisma.Decimal,
  acc: ExplosionResult,
  path: string[]
): Promise<void> {
  if (path.length > MAX_DEPTH) throw new RecipeCycleError([...path, recipeVersionId]);

  const version = await db.recipeVersion.findUnique({
    where: { id: recipeVersionId },
    include: { lines: true, recipe: true },
  });
  if (!version || version.organizationId !== ctx.organizationId) throw new NotFoundError("Recipe version not found");

  // Cycle guard by recipeId.
  if (path.includes(version.recipeId)) {
    throw new RecipeCycleError([...path, version.recipeId]);
  }
  const nextPath = [...path, version.recipeId];

  const yieldQty = D(version.yieldQty);
  if (yieldQty.lte(0)) throw new ValidationError(`Recipe version ${recipeVersionId} has non-positive yield`);
  const scale = dDiv(quantity, yieldQty);

  for (const line of version.lines) {
    const wastageFactor = D(1).plus(dDiv(D(line.wastagePct), 100));
    const effective = D(line.qty).times(scale).times(wastageFactor);

    if (line.componentType === "MATERIAL") {
      if (!line.materialId) throw new ValidationError("MATERIAL line missing materialId");
      const inBase = await convertToBase(db, ctx, line.materialId, effective, line.unitId);
      acc.set(line.materialId, (acc.get(line.materialId) ?? D(0)).plus(inBase));
    } else if (line.componentType === "SUB_RECIPE") {
      if (!line.subRecipeId) throw new ValidationError("SUB_RECIPE line missing subRecipeId");
      const subVersion = await getActiveVersion(db, ctx, line.subRecipeId);
      // `effective` is the required quantity of the sub-recipe's output.
      await explodeInto(db, ctx, subVersion.id, effective, acc, nextPath);
    } else {
      throw new ValidationError(`Unknown component type ${line.componentType}`);
    }
  }
}

export type RecipeCostLine = { materialId: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal; cost: Prisma.Decimal };
export type RecipeCost = { total: Prisma.Decimal; quantity: Prisma.Decimal; lines: RecipeCostLine[] };

/** Cost a recipe version at an outlet, for `quantity` of output (default = yield). */
export async function calculateRecipeCost(
  db: Client,
  ctx: AccessContext,
  recipeVersionId: string,
  opts: { outletId: string; quantity?: Prisma.Decimal | number | string }
): Promise<RecipeCost> {
  assertCan(ctx, "recipe.view", opts.outletId);
  const version = await db.recipeVersion.findUnique({ where: { id: recipeVersionId } });
  if (!version || version.organizationId !== ctx.organizationId) throw new NotFoundError("Recipe version not found");
  const quantity = opts.quantity !== undefined ? D(opts.quantity) : D(version.yieldQty);

  const exploded = await explodeRecipe(db, ctx, recipeVersionId, quantity);
  const costs = await db.outletMaterialCost.findMany({
    where: { organizationId: ctx.organizationId, outletId: opts.outletId, materialId: { in: [...exploded.keys()] } },
  });
  const costMap = new Map(costs.map((c) => [c.materialId, D(c.avgCost)]));

  const lines: RecipeCostLine[] = [];
  let total = D(0);
  for (const [materialId, q] of exploded) {
    const unitCost = costMap.get(materialId) ?? D(0);
    const cost = money(dMul(q, unitCost));
    total = total.plus(cost);
    lines.push({ materialId, quantity: roundQty(q), unitCost, cost });
  }
  return { total: money(total), quantity, lines };
}

// ------------------------------------------------------------
// Write-time cycle validation
// ------------------------------------------------------------

/** Build the current sub-recipe adjacency graph for the org. */
async function buildRecipeGraph(db: Client, ctx: AccessContext): Promise<RecipeGraph> {
  const lines = await db.recipeLine.findMany({
    where: { organizationId: ctx.organizationId, componentType: "SUB_RECIPE", subRecipeId: { not: null } },
    select: { recipeVersion: { select: { recipeId: true } }, subRecipeId: true },
  });
  const graph: RecipeGraph = new Map();
  for (const l of lines) {
    const parent = l.recipeVersion.recipeId;
    if (!graph.has(parent)) graph.set(parent, new Set());
    graph.get(parent)!.add(l.subRecipeId!);
    if (!graph.has(l.subRecipeId!)) graph.set(l.subRecipeId!, new Set());
  }
  return graph;
}

/** Throw if adding `subRecipeId` under `parentRecipeId` would create a cycle. */
export async function assertNoCycleOnAdd(db: Client, ctx: AccessContext, parentRecipeId: string, subRecipeId: string) {
  const graph = await buildRecipeGraph(db, ctx);
  const cycle = findCycleOnAdd(graph, parentRecipeId, subRecipeId);
  if (cycle) throw new RecipeCycleError(cycle);
}

// ------------------------------------------------------------
// Authoring: recipes, versions, lines, approval
//
// Recipes are organization-wide (consumption at every outlet uses them), so
// authoring requires `recipe.manage` and approval `recipe.approve`, each held
// by an org-wide role. Only DRAFT versions are editable; APPROVED/ARCHIVED
// versions are immutable history that past consumption was computed from.
// ------------------------------------------------------------

function assertOrgWide(ctx: AccessContext, permission: "recipe.manage" | "recipe.approve") {
  assertCan(ctx, permission);
  if (!ctx.isSuperAdmin && !ctx.isOrgWide) throw new ForbiddenError(`Recipes are organization-wide; ${permission} needs an org-wide role`);
}

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

const lineSchema = z
  .object({
    componentType: RecipeComponentType.zod,
    materialId: z.string().optional(),
    subRecipeId: z.string().optional(),
    qty: z.number().positive(),
    unitId: z.string().optional(),
    wastagePct: z.number().min(0).max(100).default(0),
    sortOrder: z.number().int().optional(),
  })
  .refine((l) => (l.componentType === "MATERIAL" ? Boolean(l.materialId) && !l.subRecipeId : Boolean(l.subRecipeId) && !l.materialId), "MATERIAL lines need materialId; SUB_RECIPE lines need subRecipeId");
export type RecipeLineInput = z.input<typeof lineSchema>;

async function loadRecipe(db: Client, ctx: AccessContext, recipeId: string) {
  const recipe = await db.recipe.findUnique({ where: { id: recipeId } });
  if (!recipe || recipe.organizationId !== ctx.organizationId) throw new NotFoundError("Recipe not found");
  return recipe;
}

async function loadDraft(tx: Tx, ctx: AccessContext, versionId: string) {
  const version = await tx.recipeVersion.findUnique({ where: { id: versionId } });
  if (!version || version.organizationId !== ctx.organizationId) throw new NotFoundError("Recipe version not found");
  if (version.status !== "DRAFT") throw new ValidationError(`Version ${version.version} is ${version.status}; only DRAFT versions can be edited`);
  return version;
}

/** Validate and insert one line into a DRAFT version (cycle-checked for sub-recipes). */
async function insertLine(tx: Tx, ctx: AccessContext, version: { id: string; recipeId: string }, input: RecipeLineInput) {
  const l = lineSchema.parse(input);
  if (l.componentType === "MATERIAL") {
    const m = await tx.material.findUnique({ where: { id: l.materialId! } });
    if (!m || m.organizationId !== ctx.organizationId) throw new NotFoundError("Material not found");
    if (l.unitId) await convertToBase(tx, ctx, l.materialId!, D(1), l.unitId); // a conversion must exist
  } else {
    const sub = await loadRecipe(tx, ctx, l.subRecipeId!);
    if (sub.outputType !== "SUB_RECIPE") throw new ValidationError("Only SUB_RECIPE recipes can be used as components");
    await assertNoCycleOnAdd(tx, ctx, version.recipeId, sub.id);
  }
  const count = await tx.recipeLine.count({ where: { recipeVersionId: version.id } });
  return tx.recipeLine.create({
    data: {
      organizationId: ctx.organizationId, recipeVersionId: version.id, componentType: l.componentType,
      materialId: l.materialId, subRecipeId: l.subRecipeId, qty: D(l.qty), unitId: l.unitId, wastagePct: D(l.wastagePct), sortOrder: l.sortOrder ?? count,
    },
  });
}

const createRecipeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  outputType: RecipeOutputType.zod,
  menuItemId: z.string().optional(),
  outputMaterialId: z.string().optional(),
  yieldQty: z.number().positive().default(1),
  yieldUnitId: z.string().optional(),
  servingSize: z.number().positive().default(1),
  notes: z.string().optional(),
  lines: z.array(z.unknown()).default([]),
});

/** Create a recipe with version 1 as a DRAFT (optionally with lines). */
export async function createRecipe(ctx: AccessContext, input: Omit<z.input<typeof createRecipeSchema>, "lines"> & { lines?: RecipeLineInput[] }, db: Client = prisma) {
  const data = createRecipeSchema.parse(input);
  assertOrgWide(ctx, "recipe.manage");
  return runInTx(db, async (tx) => {
    if (data.outputType === "MENU_ITEM") {
      if (!data.menuItemId || data.outputMaterialId) throw new ValidationError("MENU_ITEM recipes need menuItemId (and no outputMaterialId)");
      const item = await tx.menuItem.findUnique({ where: { id: data.menuItemId }, include: { recipe: true } });
      if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Menu item not found");
      if (item.recipe) throw new ValidationError(`${item.name} already has a recipe; add a new version instead`);
    } else {
      if (!data.outputMaterialId || data.menuItemId) throw new ValidationError("SUB_RECIPE recipes need outputMaterialId (and no menuItemId)");
      const m = await tx.material.findUnique({ where: { id: data.outputMaterialId } });
      if (!m || m.organizationId !== ctx.organizationId) throw new NotFoundError("Output material not found");
    }
    const recipe = await tx.recipe.create({ data: { organizationId: ctx.organizationId, name: data.name, outputType: data.outputType, menuItemId: data.menuItemId, outputMaterialId: data.outputMaterialId, createdById: actor(ctx) } });
    const version = await tx.recipeVersion.create({
      data: { organizationId: ctx.organizationId, recipeId: recipe.id, version: 1, status: "DRAFT", yieldQty: D(data.yieldQty), yieldUnitId: data.yieldUnitId, servingSize: D(data.servingSize), notes: data.notes, createdById: actor(ctx) },
    });
    for (const line of data.lines) await insertLine(tx, ctx, version, line as RecipeLineInput);
    await writeAudit(tx, ctx, { action: "RECIPE_CHANGE", entityType: "Recipe", entityId: recipe.id, after: { name: data.name, outputType: data.outputType, versionId: version.id } });
    return { recipe, version };
  });
}

const versionSchema = z.object({
  yieldQty: z.number().positive().optional(),
  yieldUnitId: z.string().optional(),
  servingSize: z.number().positive().optional(),
  notes: z.string().optional(),
  effectiveFrom: z.coerce.date().optional(),
  /** Copy lines from this version (default: the latest version). */
  copyFromVersionId: z.string().optional(),
});

/** Start a new DRAFT version (next number), copying lines/yield from an existing version. */
export async function createRecipeVersion(ctx: AccessContext, recipeId: string, input: z.input<typeof versionSchema> = {}, db: Client = prisma) {
  const data = versionSchema.parse(input);
  assertOrgWide(ctx, "recipe.manage");
  return runInTx(db, async (tx) => {
    await loadRecipe(tx, ctx, recipeId);
    const draft = await tx.recipeVersion.findFirst({ where: { recipeId, status: "DRAFT" } });
    if (draft) throw new ValidationError(`Version ${draft.version} is still a draft; edit or approve it first`);
    const latest = await tx.recipeVersion.findFirst({ where: { recipeId }, orderBy: { version: "desc" }, include: { lines: true } });
    const source = data.copyFromVersionId
      ? await tx.recipeVersion.findFirst({ where: { id: data.copyFromVersionId, recipeId }, include: { lines: true } })
      : latest;
    if (data.copyFromVersionId && !source) throw new NotFoundError("Source version not found on this recipe");
    const version = await tx.recipeVersion.create({
      data: {
        organizationId: ctx.organizationId, recipeId, version: (latest?.version ?? 0) + 1, status: "DRAFT",
        yieldQty: data.yieldQty !== undefined ? D(data.yieldQty) : source?.yieldQty ?? D(1),
        yieldUnitId: data.yieldUnitId ?? source?.yieldUnitId, servingSize: data.servingSize !== undefined ? D(data.servingSize) : source?.servingSize ?? D(1),
        notes: data.notes, ...(data.effectiveFrom ? { effectiveFrom: data.effectiveFrom } : {}), createdById: actor(ctx),
      },
    });
    for (const l of source?.lines ?? []) {
      await tx.recipeLine.create({ data: { organizationId: ctx.organizationId, recipeVersionId: version.id, componentType: l.componentType, materialId: l.materialId, subRecipeId: l.subRecipeId, qty: l.qty, unitId: l.unitId, wastagePct: l.wastagePct, sortOrder: l.sortOrder } });
    }
    await writeAudit(tx, ctx, { action: "RECIPE_CHANGE", entityType: "RecipeVersion", entityId: version.id, after: { recipeId, version: version.version, copiedFrom: source?.id } });
    return version;
  });
}

export async function updateRecipeVersion(ctx: AccessContext, versionId: string, patch: Omit<z.input<typeof versionSchema>, "copyFromVersionId">, db: Client = prisma) {
  const data = versionSchema.omit({ copyFromVersionId: true }).parse(patch);
  assertOrgWide(ctx, "recipe.manage");
  return runInTx(db, async (tx) => {
    const v = await loadDraft(tx, ctx, versionId);
    const updated = await tx.recipeVersion.update({
      where: { id: versionId },
      data: { ...data, ...(data.yieldQty !== undefined ? { yieldQty: D(data.yieldQty) } : {}), ...(data.servingSize !== undefined ? { servingSize: D(data.servingSize) } : {}) },
    });
    await writeAudit(tx, ctx, { action: "RECIPE_CHANGE", entityType: "RecipeVersion", entityId: versionId, before: { yieldQty: num(v.yieldQty), effectiveFrom: v.effectiveFrom }, after: data });
    return updated;
  });
}

export async function addRecipeLine(ctx: AccessContext, versionId: string, input: RecipeLineInput, db: Client = prisma) {
  assertOrgWide(ctx, "recipe.manage");
  return runInTx(db, async (tx) => {
    const v = await loadDraft(tx, ctx, versionId);
    const line = await insertLine(tx, ctx, v, input);
    await writeAudit(tx, ctx, { action: "RECIPE_CHANGE", entityType: "RecipeVersion", entityId: versionId, after: { addedLine: line.id, componentType: line.componentType, materialId: line.materialId, subRecipeId: line.subRecipeId, qty: num(line.qty) } });
    return line;
  });
}

export async function removeRecipeLine(ctx: AccessContext, lineId: string, db: Client = prisma) {
  assertOrgWide(ctx, "recipe.manage");
  return runInTx(db, async (tx) => {
    const line = await tx.recipeLine.findUnique({ where: { id: lineId } });
    if (!line || line.organizationId !== ctx.organizationId) throw new NotFoundError("Recipe line not found");
    await loadDraft(tx, ctx, line.recipeVersionId);
    await tx.recipeLine.delete({ where: { id: lineId } });
    await writeAudit(tx, ctx, { action: "RECIPE_CHANGE", entityType: "RecipeVersion", entityId: line.recipeVersionId, before: { removedLine: lineId, materialId: line.materialId, subRecipeId: line.subRecipeId, qty: num(line.qty) } });
    return { removed: lineId };
  });
}

/**
 * DRAFT -> APPROVED. Requires at least one line, a positive yield, and every
 * sub-recipe component to have an approved version (so the recipe can be
 * exploded). Earlier approved versions stay APPROVED as history; the active
 * one is chosen by effectiveFrom (see getActiveVersion).
 */
export async function approveRecipeVersion(ctx: AccessContext, recipeVersionId: string, db: Client = prisma) {
  assertOrgWide(ctx, "recipe.approve");
  return runInTx(db, async (tx) => {
    const version = await loadDraft(tx, ctx, recipeVersionId);
    const lines = await tx.recipeLine.findMany({ where: { recipeVersionId } });
    if (!lines.length) throw new ValidationError("Cannot approve a recipe version with no lines");
    for (const l of lines.filter((x) => x.componentType === "SUB_RECIPE")) {
      if (!(await findActiveVersion(tx, ctx, l.subRecipeId!, new Date(Math.max(Date.now(), version.effectiveFrom.getTime()))))) {
        throw new ValidationError(`Sub-recipe ${l.subRecipeId} has no approved version in effect`);
      }
    }
    await explodeRecipe(tx, ctx, recipeVersionId, version.yieldQty); // runtime cycle/unit validation
    const updated = await tx.recipeVersion.update({ where: { id: recipeVersionId }, data: { status: "APPROVED", approvedById: actor(ctx), approvedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "APPROVE", entityType: "RecipeVersion", entityId: recipeVersionId, before: { status: "DRAFT" }, after: { status: "APPROVED", effectiveFrom: version.effectiveFrom } });
    return updated;
  });
}

/** Retire an APPROVED (or abandon a DRAFT) version. History rows are kept, never deleted. */
export async function archiveRecipeVersion(ctx: AccessContext, recipeVersionId: string, db: Client = prisma) {
  assertOrgWide(ctx, "recipe.approve");
  return runInTx(db, async (tx) => {
    const v = await tx.recipeVersion.findUnique({ where: { id: recipeVersionId } });
    if (!v || v.organizationId !== ctx.organizationId) throw new NotFoundError("Recipe version not found");
    if (!canTransition(RECIPE_VERSION_TRANSITIONS, v.status as RecipeStatus, "ARCHIVED")) throw new ValidationError("Version is already archived");
    const updated = await tx.recipeVersion.update({ where: { id: recipeVersionId }, data: { status: "ARCHIVED" } });
    await writeAudit(tx, ctx, { action: "RECIPE_CHANGE", entityType: "RecipeVersion", entityId: recipeVersionId, before: { status: v.status }, after: { status: "ARCHIVED" } });
    return updated;
  });
}

/** id -> unit code for the given unit ids (org-scoped, one bounded query). */
async function unitCodes(db: Client, ctx: AccessContext, ids: Array<string | null | undefined>) {
  const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!wanted.length) return new Map<string, string>();
  const units = await db.unit.findMany({ where: { organizationId: ctx.organizationId, id: { in: wanted } }, select: { id: true, code: true } });
  return new Map(units.map((u) => [u.id, u.code]));
}

/**
 * A recipe with its version history. Display names (materials, sub-recipes,
 * units, output) are resolved here so anyone with recipe.view can read the
 * recipe without also needing master-data access.
 */
export async function getRecipe(db: Client, ctx: AccessContext, recipeId: string) {
  assertCan(ctx, "recipe.view");
  await loadRecipe(db, ctx, recipeId);
  const recipe = await db.recipe.findUnique({
    where: { id: recipeId },
    include: {
      menuItem: { select: { id: true, name: true, price: true } },
      versions: {
        orderBy: { version: "desc" },
        include: {
          lines: {
            orderBy: { sortOrder: "asc" },
            include: { material: { select: { name: true, sku: true, baseUnitId: true } }, subRecipe: { select: { name: true, outputMaterialId: true } } },
          },
        },
      },
    },
  });
  if (!recipe) throw new NotFoundError("Recipe not found");
  const output = recipe.outputMaterialId
    ? await db.material.findFirst({ where: { id: recipe.outputMaterialId, organizationId: ctx.organizationId }, select: { id: true, name: true, sku: true, baseUnitId: true } })
    : null;
  const lines = recipe.versions.flatMap((v) => v.lines);
  const codes = await unitCodes(db, ctx, [...lines.flatMap((l) => [l.unitId, l.material?.baseUnitId]), ...recipe.versions.map((v) => v.yieldUnitId), output?.baseUnitId]);
  return {
    ...recipe,
    outputMaterial: output ? { id: output.id, name: output.name, sku: output.sku, unit: codes.get(output.baseUnitId) ?? null } : null,
    versions: recipe.versions.map((v) => ({
      ...v,
      yieldUnit: v.yieldUnitId ? codes.get(v.yieldUnitId) ?? null : null,
      lines: v.lines.map(({ material, subRecipe, ...l }) => ({
        ...l,
        name: material?.name ?? subRecipe?.name ?? null,
        sku: material?.sku ?? null,
        /** The unit the quantity is expressed in (the material's base unit when unitId is empty). */
        unit: (l.unitId ? codes.get(l.unitId) : material ? codes.get(material.baseUnitId) : null) ?? null,
      })),
    })),
  };
}

export async function listRecipes(db: Client, ctx: AccessContext, opts: { outputType?: string; search?: string; take?: number; cursor?: string } = {}) {
  assertCan(ctx, "recipe.view");
  return db.recipe.findMany({
    where: { organizationId: ctx.organizationId, ...(opts.outputType ? { outputType: opts.outputType } : {}), ...(opts.search ? { name: textContains(opts.search) } : {}) },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: Math.min(opts.take ?? 100, 500),
    include: {
      menuItem: { select: { name: true } },
      versions: { orderBy: { version: "desc" }, select: { id: true, version: true, status: true, effectiveFrom: true } },
    },
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
}

/** Material names / SKUs / base units for cost lines (org-scoped). */
export async function describeCostLines(db: Client, ctx: AccessContext, lines: RecipeCostLine[]) {
  const materials = await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: lines.map((l) => l.materialId) } }, select: { id: true, name: true, sku: true, baseUnitId: true } });
  const byId = new Map(materials.map((m) => [m.id, m]));
  const codes = await unitCodes(db, ctx, materials.map((m) => m.baseUnitId));
  return lines.map((l) => {
    const m = byId.get(l.materialId);
    return { materialId: l.materialId, name: m?.name ?? null, sku: m?.sku ?? null, unit: m ? codes.get(m.baseUnitId) ?? null : null, quantity: num(l.quantity), unitCost: num(l.unitCost), cost: num(l.cost) };
  });
}

/** Theoretical plate cost of a menu item at an outlet (active version, current avg cost) vs its price. */
export async function menuItemCostAndMargin(db: Client, ctx: AccessContext, menuItemId: string, outletId: string) {
  assertOutletAccess(ctx, outletId);
  const item = await db.menuItem.findUnique({ where: { id: menuItemId } });
  if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Menu item not found");
  const version = await getActiveVersionForMenuItem(db, ctx, menuItemId);
  if (!version) throw new ValidationError(`${item.name} has no approved recipe`);
  const cost = await calculateRecipeCost(db, ctx, version.id, { outletId, quantity: 1 });
  const price = D(item.price);
  return {
    menuItemId, versionId: version.id, price: num(price), cost: num(cost.total), margin: num(money(price.minus(cost.total))),
    foodCostPct: price.gt(0) ? num(money(cost.total.div(price).times(100))) : 0, lines: cost.lines,
  };
}

