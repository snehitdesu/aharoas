/**
 * Order / POS domain service (business logic; no UI).
 *
 * Order lifecycle is governed by ORDER_TRANSITIONS. Totals are computed by a
 * pure function so they can be unit-tested independently of the database.
 * Inventory is NOT consumed here — consumption happens once, on payment
 * success or POS settlement, via orderConsumption.consumeInventoryForOrder.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  OrderChannel,
  OrderSource,
  OrderStatus,
  ORDER_TRANSITIONS,
  canTransition,
} from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { runInTx } from "@/server/services/_workflow";
import { createHash } from "node:crypto";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError, ConflictError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { D, dMul, dDiv, money } from "@/domain/money";
import { priceMenuSelection } from "@/server/services/menu";
import { createKOTsForOrder } from "@/server/services/kot";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

// Transactions: shared runInTx (Serializable + bounded retry) from _workflow.ts.

// ------------------------------------------------------------
// Pure totals calculation
// ------------------------------------------------------------

export type TotalsItem = {
  qty: Prisma.Decimal | number | string;
  unitPrice: Prisma.Decimal | number | string;
  discount?: Prisma.Decimal | number | string;
  taxPct: Prisma.Decimal | number | string;
  /** Sum of modifier price deltas for ONE unit (charged per unit, i.e. × qty). */
  modifiersPerUnit?: Prisma.Decimal | number | string;
};

export type Totals = { subtotal: Prisma.Decimal; tax: Prisma.Decimal; discount: Prisma.Decimal; total: Prisma.Decimal };

/**
 * Line net = qty*(unitPrice + modifiersPerUnit) - lineDiscount.
 * Tax is charged per line on its net. Order-level discount reduces the payable
 * total after tax base is established on the lines.
 */
export function calculateOrderTotals(items: TotalsItem[], orderDiscount: Prisma.Decimal | number | string = 0): Totals {
  let subtotal = D(0);
  let tax = D(0);
  for (const it of items) {
    const gross = dMul(it.qty, D(it.unitPrice).plus(D(it.modifiersPerUnit ?? 0)));
    const net = gross.minus(D(it.discount ?? 0));
    if (net.lt(0)) throw new ValidationError("Line discount exceeds line value");
    subtotal = subtotal.plus(net);
    tax = tax.plus(dMul(net, dDiv(D(it.taxPct), 100)));
  }
  const disc = D(orderDiscount);
  if (disc.gt(subtotal)) throw new ValidationError("Order discount exceeds subtotal");
  const total = subtotal.minus(disc).plus(tax);
  return { subtotal: money(subtotal), tax: money(tax), discount: money(disc), total: money(total) };
}

/** Recompute and persist an order's totals from its current items. */
export async function recomputeTotals(tx: Tx, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { modifiers: true } } } });
  if (!order) throw new NotFoundError("Order not found");
  const items: TotalsItem[] = order.items.map((it) => ({
    qty: it.qty,
    unitPrice: it.unitPrice,
    discount: it.discount,
    taxPct: it.taxPct,
    modifiersPerUnit: it.modifiers.reduce((a, m) => a.plus(D(m.priceDelta)), D(0)),
  }));
  const totals = calculateOrderTotals(items, order.discount);
  // keep persisted lineTotal in sync
  for (const it of order.items) {
    const modTotal = it.modifiers.reduce((a, m) => a.plus(D(m.priceDelta)), D(0));
    const net = dMul(it.qty, D(it.unitPrice).plus(modTotal)).minus(D(it.discount));
    await tx.orderItem.update({ where: { id: it.id }, data: { lineTotal: money(net) } });
  }
  return tx.order.update({
    where: { id: orderId },
    data: { subtotal: totals.subtotal, tax: totals.tax, total: totals.total },
  });
}

// ------------------------------------------------------------
// Commands
// ------------------------------------------------------------

const createOrderSchema = z.object({
  outletId: z.string().min(1),
  channel: OrderChannel.zod.default("DINE_IN"),
  source: OrderSource.zod.default("POS"),
  tableId: z.string().optional(),
  customerId: z.string().optional(),
  externalRef: z.string().optional(),
  covers: z.number().int().positive().default(1),
  notes: z.string().optional(),
  /** Idempotency-Key: a retry with the same key + request returns the original order. */
  idempotencyKey: z.string().trim().min(8).max(100).regex(/^[\w.:-]+$/, "Invalid idempotency key").optional(),
});
export type CreateOrderInput = z.input<typeof createOrderSchema>;

/** Stable hash of the order-creation request (everything but the key itself). */
function requestHashOf(data: { idempotencyKey?: string } & Record<string, unknown>): string {
  const { idempotencyKey: _k, ...rest } = data;
  void _k;
  const canonical = JSON.stringify(Object.keys(rest).sort().map((k) => [k, (rest as Record<string, unknown>)[k] ?? null]));
  return createHash("sha256").update(canonical).digest("hex");
}

/** Resolve a replay: same actor, outlet and request -> original order; anything else -> 409. */
function replayOrConflict(existing: { createdById: string | null; outletId: string; requestHash: string | null }, ctx: AccessContext, outletId: string, hash: string) {
  const actor = ctx.userId === "system" ? null : ctx.userId;
  if (existing.createdById !== actor || existing.outletId !== outletId || existing.requestHash !== hash) {
    throw new ConflictError("Idempotency key was already used for a different request");
  }
}

export type CreateOrderResult = Awaited<ReturnType<Tx["order"]["create"]>> & { replayed?: boolean };

export async function createOrder(ctx: AccessContext, input: CreateOrderInput, db: Client = prisma): Promise<CreateOrderResult> {
  const data = createOrderSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "order.create", data.outletId);
  const hash = data.idempotencyKey ? requestHashOf(data as never) : null;
  const findPrior = () => db.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: data.idempotencyKey! } } });
  if (data.idempotencyKey) {
    const prior = await findPrior();
    if (prior) {
      replayOrConflict(prior, ctx, data.outletId, hash!);
      return { ...prior, replayed: true };
    }
  }
  try {
    return await createOrderTx(ctx, data, hash, db);
  } catch (e) {
    // Lost a concurrent race on the same key: the winner's order is the result.
    if (data.idempotencyKey && (e as { code?: string })?.code === "P2002") {
      const prior = await findPrior();
      if (prior) {
        replayOrConflict(prior, ctx, data.outletId, hash!);
        return { ...prior, replayed: true };
      }
    }
    throw e;
  }
}

function createOrderTx(ctx: AccessContext, data: z.infer<typeof createOrderSchema>, hash: string | null, db: Client) {
  return runInTx(db, async (tx) => {
    await assertOutletInOrg(tx, ctx, data.outletId); // outlet must belong to the caller's org (org-wide tenant guard)
    if (data.tableId) {
      const table = await tx.restaurantTable.findUnique({ where: { id: data.tableId } });
      if (!table || table.organizationId !== ctx.organizationId || table.outletId !== data.outletId) throw new ValidationError("Table not in this outlet");
    }
    if (data.customerId) {
      const customer = await tx.customer.findUnique({ where: { id: data.customerId }, select: { organizationId: true } });
      if (!customer || customer.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
    }
    const order = await tx.order.create({
      data: {
        organizationId: ctx.organizationId,
        outletId: data.outletId,
        channel: data.channel,
        source: data.source,
        tableId: data.tableId,
        customerId: data.customerId,
        externalRef: data.externalRef,
        covers: data.covers,
        notes: data.notes,
        idempotencyKey: data.idempotencyKey,
        requestHash: hash,
        status: "OPEN",
        createdById: ctx.userId === "system" ? null : ctx.userId,
      },
    });
    if (data.tableId) await tx.restaurantTable.update({ where: { id: data.tableId }, data: { status: "OCCUPIED" } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Order", entityId: order.id, outletId: data.outletId });
    return order;
  });
}

const addItemSchema = z.object({
  menuItemId: z.string().optional(),
  variantId: z.string().optional(),
  modifierOptionIds: z.array(z.string()).optional(),
  posItemCode: z.string().optional(),
  name: z.string().optional(),
  qty: z.number().positive().default(1),
  unitPrice: z.number().nonnegative().optional(),
  taxPct: z.number().nonnegative().optional(),
  station: z.string().optional(),
  notes: z.string().optional(),
  modifiers: z.array(z.object({ name: z.string(), priceDelta: z.number().default(0) })).optional(),
});
export type AddItemInput = z.input<typeof addItemSchema>;

export function addOrderItem(ctx: AccessContext, orderId: string, input: AddItemInput, db: Client = prisma) {
  const data = addItemSchema.parse(input);
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.modify", order.outletId);
    if (!["OPEN", "SENT", "PREPARING"].includes(order.status)) {
      throw new ValidationError(`Cannot add items to a ${order.status} order`);
    }

    // Menu items are priced by the menu (variant + configured modifier options);
    // client-supplied prices are only accepted for open (non-menu) items.
    let name: string;
    let unitPrice: Prisma.Decimal;
    let taxPct: Prisma.Decimal;
    let station: string;
    let modifiers: Array<{ name: string; priceDelta: Prisma.Decimal }>;
    if (data.menuItemId) {
      if (data.unitPrice !== undefined || data.taxPct !== undefined || data.modifiers?.length) {
        throw new ValidationError("Menu items are priced by the menu; use variantId/modifierOptionIds, or a discount");
      }
      const priced = await priceMenuSelection(tx, ctx, { menuItemId: data.menuItemId, variantId: data.variantId, modifierOptionIds: data.modifierOptionIds, outletId: order.outletId });
      ({ name, unitPrice, taxPct, station, modifiers } = priced);
    } else {
      if (data.variantId || data.modifierOptionIds?.length) throw new ValidationError("Variants/modifier options need a menuItemId");
      if (!data.name) throw new ValidationError("Item name is required when no menu item is given");
      name = data.name;
      unitPrice = D(data.unitPrice ?? 0);
      taxPct = D(data.taxPct ?? 0);
      station = data.station ?? "KITCHEN";
      modifiers = (data.modifiers ?? []).map((m) => ({ name: m.name, priceDelta: D(m.priceDelta) }));
    }

    const modsPerUnit = modifiers.reduce((a, m) => a.plus(m.priceDelta), D(0));
    const net = dMul(data.qty, unitPrice.plus(modsPerUnit));
    const item = await tx.orderItem.create({
      data: {
        organizationId: ctx.organizationId,
        outletId: order.outletId,
        orderId,
        menuItemId: data.menuItemId,
        posItemCode: data.posItemCode,
        name,
        qty: D(data.qty),
        unitPrice: money(unitPrice),
        taxPct,
        lineTotal: money(net),
        station,
        notes: data.notes,
        modifiers: modifiers.length ? { create: modifiers.map((m) => ({ name: m.name, priceDelta: money(m.priceDelta) })) } : undefined,
      },
    });
    await recomputeTotals(tx, orderId);
    return item;
  });
}

export function updateOrderItem(
  ctx: AccessContext,
  orderItemId: string,
  patch: { qty?: number; discount?: number; notes?: string },
  db: Client = prisma
) {
  return runInTx(db, async (tx) => {
    const item = await tx.orderItem.findUnique({ where: { id: orderItemId }, include: { order: true } });
    if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Order item not found");
    assertCan(ctx, "order.modify", item.outletId);
    if (item.order.status === "PAID" || item.order.status === "CANCELLED") throw new ValidationError("Order is closed");
    if (patch.qty !== undefined && patch.qty <= 0) throw new ValidationError("Quantity must be positive");
    await tx.orderItem.update({
      where: { id: orderItemId },
      data: {
        qty: patch.qty !== undefined ? D(patch.qty) : undefined,
        discount: patch.discount !== undefined ? money(patch.discount) : undefined,
        notes: patch.notes,
      },
    });
    return recomputeTotals(tx, item.orderId);
  });
}

export function applyDiscount(ctx: AccessContext, orderId: string, amount: number, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertCan(ctx, "order.discount", order.outletId);
    if (amount < 0) throw new ValidationError("Discount cannot be negative");
    await tx.order.update({ where: { id: orderId }, data: { discount: money(amount) } });
    return recomputeTotals(tx, orderId);
  });
}

export function submitOrder(ctx: AccessContext, orderId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertCan(ctx, "order.modify", order.outletId);
    if (!canTransition(ORDER_TRANSITIONS, order.status as OrderStatus, "SENT")) {
      throw new ValidationError(`Cannot submit an order in status ${order.status}`);
    }
    if (order.items.length === 0) throw new ValidationError("Cannot submit an empty order");
    const updated = await tx.order.update({ where: { id: orderId }, data: { status: "SENT" } });
    // Route every item to its preparation station (one KOT per station).
    const kots = await createKOTsForOrder(tx, ctx, orderId);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { status: order.status }, after: { status: "SENT", kots: kots.map((k) => k.number) } });
    return updated;
  });
}

/** Send items added after submission to the kitchen (new KOTs for items not yet on one). */
export async function fireOrderItems(ctx: AccessContext, orderId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.modify", order.outletId);
    if (!["SENT", "PREPARING", "READY", "SERVED"].includes(order.status)) throw new ValidationError(`Submit the order first (status ${order.status})`);
    const kots = await createKOTsForOrder(tx, ctx, orderId);
    if (kots.length) await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, after: { firedKots: kots.map((k) => k.number) } });
    return kots;
  });
}

export function cancelOrder(ctx: AccessContext, orderId: string, reason: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertCan(ctx, "order.cancel", order.outletId);
    if (!canTransition(ORDER_TRANSITIONS, order.status as OrderStatus, "CANCELLED")) {
      throw new ValidationError(`Cannot cancel an order in status ${order.status}`);
    }
    const updated = await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", notes: reason } });
    if (order.tableId) await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: "AVAILABLE" } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "Order", entityId: orderId, outletId: order.outletId, after: { reason } });
    return updated;
  });
}

// ------------------------------------------------------------
// Queries
// ------------------------------------------------------------

const customerSelect = { select: { id: true, name: true, phone: true, email: true } } as const;

export async function getOrder(db: PrismaClient, ctx: AccessContext, orderId: string) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { customer: customerSelect, items: { include: { modifiers: true } }, payments: { include: { refunds: true } }, kots: { include: { items: true } } },
  });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, order.outletId);
  assertCan(ctx, "order.view", order.outletId);
  return order;
}

const listSchema = z.object({
  outletId: z.string().min(1),
  status: OrderStatus.zod.optional(),
  /** Only orders still running (not PAID / CANCELLED / REFUNDED). */
  active: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(),
  tableId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  take: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

/** Orders at one outlet, newest first, cursor-paginated. */
export async function listOrders(db: PrismaClient, ctx: AccessContext, input: z.input<typeof listSchema>) {
  const f = listSchema.parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "order.view", f.outletId);
  const createdAt = f.from || f.to ? { gte: f.from, lte: f.to } : undefined;
  const rows = await db.order.findMany({
    where: {
      organizationId: ctx.organizationId, outletId: f.outletId, ...(f.status ? { status: f.status } : {}), ...(f.tableId ? { tableId: f.tableId } : {}), ...(createdAt ? { createdAt } : {}),
      ...(f.active ? { status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: f.take + 1,
    include: { customer: customerSelect, items: { select: { id: true, name: true, qty: true, lineTotal: true } } },
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, f.take);
  return { items, nextCursor: rows.length > f.take ? items[items.length - 1].id : null };
}

// ------------------------------------------------------------
// Atomic POS placement
// ------------------------------------------------------------

const placeSchema = createOrderSchema.extend({
  items: z.array(z.record(z.unknown())).min(1).max(100),
  /** true = also send to the kitchen (KOTs) in the same transaction. */
  submit: z.boolean().default(false),
});
export type PlaceOrderInput = z.input<typeof placeSchema>;

const placedInclude = { customer: customerSelect, items: { include: { modifiers: true } }, kots: { select: { id: true, number: true, status: true } } } as const;

/** Count of orders at an outlet (dashboard KPI). Same auth as listOrders; no item payload. */
export async function countOrders(db: PrismaClient, ctx: AccessContext, input: { outletId: string; active?: boolean }) {
  const f = listSchema.pick({ outletId: true, active: true }).parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "order.view", f.outletId);
  return db.order.count({
    where: {
      organizationId: ctx.organizationId,
      outletId: f.outletId,
      ...(f.active ? { status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] } } : {}),
    },
  });
}

/**
 * POS entry point: create an order with all its lines (and optionally send it
 * to the kitchen) in ONE transaction. With an Idempotency-Key the whole request
 * is idempotent — a retry returns the original order, and a partial failure
 * leaves nothing behind (no half-created orders, no duplicated lines).
 * Items are priced server-side by addOrderItem (menu items) exactly as usual.
 */
export async function placeOrder(ctx: AccessContext, input: PlaceOrderInput, db: Client = prisma) {
  const data = placeSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "order.create", data.outletId);
  const { items, submit, ...orderInput } = data;
  const hash = data.idempotencyKey ? requestHashOf(data as never) : null;
  const replay = async () => {
    const prior = await db.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: data.idempotencyKey! } }, include: placedInclude });
    if (!prior) return null;
    replayOrConflict(prior, ctx, data.outletId, hash!);
    return { ...prior, replayed: true };
  };
  if (data.idempotencyKey) {
    const prior = await replay();
    if (prior) return prior;
  }
  try {
    return await runInTx(db, async (tx) => {
      const order = await createOrderTx(ctx, orderInput, hash, tx);
      for (const item of items) await addOrderItem(ctx, order.id, item as AddItemInput, tx);
      if (submit) await submitOrder(ctx, order.id, tx);
      return { ...(await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: placedInclude })), replayed: false };
    });
  } catch (e) {
    if (data.idempotencyKey && (e as { code?: string })?.code === "P2002") {
      const prior = await replay();
      if (prior) return prior;
    }
    throw e;
  }
}
