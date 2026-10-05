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
import { createHash, randomUUID } from "node:crypto";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError, ConflictError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { D, dMul, dDiv, money, moneyAmount } from "@/domain/money";
import { priceMenuSelection } from "@/server/services/menu";
import { createKOTsForOrder } from "@/server/services/kot";
import { idempotentCreate, requestHashOf as roundHashOf } from "@/server/services/idempotency";
import { createNotificationTx } from "@/server/services/notifications";

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

/** Taxable value and tax per rate (the order's tax breakdown). */
export type RateTax = { ratePct: Prisma.Decimal; taxable: Prisma.Decimal; tax: Prisma.Decimal };
export type Totals = { subtotal: Prisma.Decimal; tax: Prisma.Decimal; discount: Prisma.Decimal; total: Prisma.Decimal; byRate: RateTax[] };

/**
 * Apportion an order-level discount over line nets: each line gets
 * round₂(discount × net / Σnet); the rounding remainder goes to the largest
 * line (the first one on ties) so the shares sum to the discount exactly.
 * The single implementation shared by pricing, invoices and item analytics.
 */
export function apportionOrderDiscount(nets: Prisma.Decimal[], discount: Prisma.Decimal | number | string): Prisma.Decimal[] {
  const disc = D(discount);
  const subtotal = nets.reduce((a, n) => a.plus(n), D(0));
  const shares = nets.map(() => D(0));
  if (disc.gt(0) && subtotal.gt(0)) {
    let largest = 0;
    nets.forEach((n, i) => { if (n.gt(nets[largest])) largest = i; });
    let given = D(0);
    nets.forEach((n, i) => {
      if (i === largest) return;
      shares[i] = money(disc.times(n).div(subtotal));
      given = given.plus(shares[i]);
    });
    shares[largest] = disc.minus(given);
  }
  return shares;
}

/**
 * Order totals — tax AFTER discount (GST is levied on the discounted value):
 *
 *   line net      = qty × (unitPrice + modifiersPerUnit) − line discount
 *   order discount is apportioned to the lines in proportion to their net,
 *                   each share rounded to the paisa, the rounding remainder on
 *                   the largest line (so the shares add up to the discount exactly)
 *   taxable       = line net − its share of the order discount
 *   tax per rate  = round₂(Σ taxable at that rate × rate %)
 *   tax           = Σ tax per rate          (what an invoice shows per rate)
 *   total         = round₂(Σ net − discount + tax)
 *
 * The same function prices orders, bills and invoices, so they always agree.
 */
export function calculateOrderTotals(items: TotalsItem[], orderDiscount: Prisma.Decimal | number | string = 0): Totals {
  const nets = items.map((it) => {
    const net = dMul(it.qty, D(it.unitPrice).plus(D(it.modifiersPerUnit ?? 0))).minus(D(it.discount ?? 0));
    if (net.lt(0)) throw new ValidationError("Line discount exceeds line value");
    return net;
  });
  const subtotal = nets.reduce((a, n) => a.plus(n), D(0));
  const disc = D(orderDiscount);
  if (disc.lt(0)) throw new ValidationError("Discount cannot be negative");
  if (disc.gt(subtotal)) throw new ValidationError("Order discount exceeds subtotal");

  const shares = apportionOrderDiscount(nets, disc);

  const groups = new Map<string, { ratePct: Prisma.Decimal; taxable: Prisma.Decimal }>();
  items.forEach((it, i) => {
    const taxable = Prisma.Decimal.max(nets[i].minus(shares[i]), D(0));
    const key = D(it.taxPct).toString();
    const g = groups.get(key) ?? { ratePct: D(it.taxPct), taxable: D(0) };
    g.taxable = g.taxable.plus(taxable);
    groups.set(key, g);
  });
  const byRate = [...groups.values()]
    .map((g) => ({ ratePct: g.ratePct, taxable: money(g.taxable), tax: money(dMul(g.taxable, dDiv(g.ratePct, 100))) }))
    .sort((a, b) => a.ratePct.cmp(b.ratePct));
  const tax = byRate.reduce((a, r) => a.plus(r.tax), D(0));
  const total = subtotal.minus(disc).plus(tax);
  return { subtotal: money(subtotal), tax: money(tax), discount: money(disc), total: money(total), byRate };
}

/**
 * Free a table when one of its orders closes (paid / cancelled) — but only if
 * no OTHER order is still running at it (several QR guest orders, or a captain
 * order next to a guest's, can share a table). Marking it AVAILABLE regardless
 * made the table picker and the floor screens offer an occupied table.
 */
export async function releaseTableTx(tx: Tx, tableId: string, closingOrderId: string) {
  const others = await tx.order.count({ where: { tableId, id: { not: closingOrderId }, status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] } } });
  if (others === 0) await tx.restaurantTable.update({ where: { id: tableId }, data: { status: "AVAILABLE" } });
}

/** Statuses in which an order's lines, discount and total are frozen. */
const CLOSED_STATUSES = ["PAID", "CANCELLED", "REFUNDED"];

/**
 * Money the order currently holds: SUCCESS + PARTIAL payments less their
 * refunds. (The payment service's outstanding-balance rule counts PARTIAL at
 * full amount; for "may this order be cancelled / repriced" the refunds matter.)
 */
async function heldTx(tx: Tx, orderId: string) {
  const payments = await tx.payment.findMany({ where: { orderId, status: { in: ["SUCCESS", "PARTIAL"] } }, include: { refunds: { select: { amount: true } } } });
  const gross = payments.reduce((a, p) => a.plus(D(p.amount)), D(0));
  const net = payments.reduce((a, p) => a.plus(D(p.amount)).minus(p.refunds.reduce((r, x) => r.plus(D(x.amount)), D(0))), D(0));
  return { gross, net };
}

/** A repricing (discount, quantity) may never take the total below what the guest already paid. */
async function assertTotalCoversPaymentsTx(tx: Tx, orderId: string, total: Prisma.Decimal) {
  const { gross } = await heldTx(tx, orderId);
  if (D(total).lt(gross)) throw new ValidationError(`The new total ${money(total).toString()} is below the ${money(gross).toString()} already paid; refund first`);
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
  // keep persisted lineTotal in sync (only lines whose value changed are written:
  // rewriting every line of a long-running order on each round cost a write per
  // line and widened the conflict surface of concurrent rounds)
  for (const it of order.items) {
    const modTotal = it.modifiers.reduce((a, m) => a.plus(D(m.priceDelta)), D(0));
    const net = money(dMul(it.qty, D(it.unitPrice).plus(modTotal)).minus(D(it.discount)));
    if (!net.eq(D(it.lineTotal))) await tx.orderItem.update({ where: { id: it.id }, data: { lineTotal: net } });
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

/**
 * Isolation for creating a NEW order (alone or with its lines and KOTs):
 * READ COMMITTED on PostgreSQL, deliberately. Every row this transaction writes
 * is new and invisible to other transactions until commit (the order, its
 * lines, modifiers, KOTs, KOT items, audit rows); the only pre-existing row it
 * writes is the table's display status (a blind last-writer-wins UPDATE, no
 * invariant). Everything else it reads is reference data (outlet, table,
 * customer, menu prices / sold-out flags, stations) that it never writes, so a
 * concurrent change is indistinguishable from that change committing just
 * after this order — the same outcome SERIALIZABLE would allow. Guarantees that
 * matter are enforced by the database at any isolation level: the idempotency
 * key by the unique (organizationId, idempotencyKey) index (the loser gets
 * P2002 and replays the winner), KOT numbers by a sequence. SERIALIZABLE only
 * added SSI false positives here (docs/production-infrastructure.md
 * §Transaction isolation). Changes to an EXISTING order (items, discounts,
 * rounds, bill, cancel) and settlement stay SERIALIZABLE.
 */
const NEW_ORDER_TX = { isolation: "readCommitted" } as const;

/**
 * A change to an EXISTING order: SERIALIZABLE (lost-update protection on the
 * order, its lines and totals), queued in-process per order so two captains /
 * a captain and a cashier editing the same order run one after the other
 * instead of aborting each other (keyedLock.ts).
 */
const orderTx = <T>(db: Client, orderId: string, fn: (tx: Tx) => Promise<T>) => runInTx(db, fn, { lockKey: `order:${orderId}` });

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
  }, NEW_ORDER_TX);
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
  return orderTx(db, orderId, async (tx) => {
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
    let variantId: string | undefined;
    let modifiers: Array<{ name: string; priceDelta: Prisma.Decimal; optionId?: string }>;
    if (data.menuItemId) {
      if (data.unitPrice !== undefined || data.taxPct !== undefined || data.modifiers?.length) {
        throw new ValidationError("Menu items are priced by the menu; use variantId/modifierOptionIds, or a discount");
      }
      const priced = await priceMenuSelection(tx, ctx, { menuItemId: data.menuItemId, variantId: data.variantId, modifierOptionIds: data.modifierOptionIds, outletId: order.outletId });
      ({ name, unitPrice, taxPct, station, modifiers, variantId } = priced);
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
        variantId,
        posItemCode: data.posItemCode,
        name,
        qty: D(data.qty),
        unitPrice: money(unitPrice),
        taxPct,
        lineTotal: money(net),
        station,
        notes: data.notes,
        modifiers: modifiers.length ? { create: modifiers.map((m) => ({ name: m.name, priceDelta: money(m.priceDelta), optionId: m.optionId })) } : undefined,
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
    const item = await tx.orderItem.findUnique({ where: { id: orderItemId }, include: { order: true, kotItems: { include: { kot: { select: { status: true } } } } } });
    if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Order item not found");
    assertOutletAccess(ctx, item.outletId);
    assertCan(ctx, "order.modify", item.outletId);
    if (CLOSED_STATUSES.includes(item.order.status)) throw new ValidationError("Order is closed");
    if (patch.qty !== undefined && patch.qty <= 0) throw new ValidationError("Quantity must be positive");
    // The kitchen is already making what its ticket says; changing the quantity
    // here would silently diverge from the KOT. Void the ticket at the KDS instead.
    if (patch.qty !== undefined && !D(patch.qty).eq(D(item.qty)) && item.kotItems.some((k) => k.kot.status !== "CANCELLED")) {
      throw new ValidationError("This item was already sent to the kitchen; its quantity cannot be changed");
    }
    await tx.orderItem.update({
      where: { id: orderItemId },
      data: {
        qty: patch.qty !== undefined ? D(patch.qty) : undefined,
        discount: patch.discount !== undefined ? money(patch.discount) : undefined,
        notes: patch.notes,
      },
    });
    const updated = await recomputeTotals(tx, item.orderId);
    await assertTotalCoversPaymentsTx(tx, item.orderId, D(updated.total));
    return updated;
  });
}

export function applyDiscount(ctx: AccessContext, orderId: string, amount: number, db: Client = prisma) {
  return orderTx(db, orderId, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.discount", order.outletId);
    if (CLOSED_STATUSES.includes(order.status)) throw new ValidationError(`Cannot discount a ${order.status} order`);
    moneyAmount(z.number().nonnegative("Discount cannot be negative")).parse(amount);
    await tx.order.update({ where: { id: orderId }, data: { discount: money(amount) } });
    const updated = await recomputeTotals(tx, orderId);
    await assertTotalCoversPaymentsTx(tx, orderId, D(updated.total));
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { discount: money(order.discount).toFixed(2), total: money(order.total).toFixed(2) }, after: { discount: money(amount).toFixed(2), total: money(updated.total).toFixed(2) } });
    return updated;
  });
}

export function submitOrder(ctx: AccessContext, orderId: string, db: Client = prisma) {
  return orderTx(db, orderId, async (tx) => {
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
  return orderTx(db, orderId, async (tx) => {
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

// ------------------------------------------------------------
// Rounds (captain / POS): add several menu items and send them in ONE step
// ------------------------------------------------------------

/** A round line: menu items only — the price, tax and modifier deltas always come from the menu. */
const roundLineSchema = z
  .object({
    menuItemId: z.string().min(1),
    variantId: z.string().optional(),
    modifierOptionIds: z.array(z.string()).max(20).optional(),
    qty: z.number().positive().max(100),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();
const roundSchema = z.object({ items: z.array(roundLineSchema).min(1).max(50), fire: z.boolean().default(true) }).strict();
export type OrderRoundInput = z.input<typeof roundSchema>;

/**
 * Add a round of menu items to a running order and (by default) send it to
 * the kitchen, atomically: either every line is added and its KOT created, or
 * nothing is. With an Idempotency-Key, a retried round (lost response, double
 * tap, flaky phone network) returns the original round — the lines and KOTs
 * are never created twice; the same key with a different round is a 409.
 * An order still OPEN is submitted (all its unsent lines go to the kitchen);
 * a sent order gets new KOTs for the new lines only.
 */
export async function addOrderRound(ctx: AccessContext, orderId: string, input: OrderRoundInput, idempotencyKey?: string, db: Client = prisma) {
  const data = roundSchema.parse(input);
  const hash = roundHashOf(ctx, "order-round", { orderId, ...data });
  const round = await idempotentCreate({
    key: idempotencyKey,
    hash,
    findPrior: async (key) => {
      const prior = await db.orderRound.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
      if (prior && prior.orderId !== orderId) throw new ConflictError("Idempotency key was already used for a different request");
      return prior;
    },
    create: (key, h) =>
      orderTx(db, orderId, async (tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
        assertOutletAccess(ctx, order.outletId);
        assertCan(ctx, "order.modify", order.outletId);
        // addOrderItem re-checks the status (no lines on BILLED / PAID / CANCELLED / REFUNDED orders).
        for (const line of data.items) await addOrderItem(ctx, orderId, line, tx);
        let kots: Array<{ number: number }> = [];
        if (data.fire) {
          if (order.status === "OPEN") {
            await submitOrder(ctx, orderId, tx);
            kots = await tx.kot.findMany({ where: { orderId }, select: { number: true } });
          } else {
            kots = await createKOTsForOrder(tx, ctx, orderId);
          }
        }
        const created = await tx.orderRound.create({
          data: {
            organizationId: ctx.organizationId,
            orderId,
            // Without a client key the round still gets a unique (never replayable) key.
            idempotencyKey: key ?? `nokey:${randomUUID()}`,
            requestHash: h ?? hash,
            itemCount: data.items.length,
            fired: data.fire,
            createdById: ctx.userId === "system" ? null : ctx.userId,
          },
        });
        await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, after: { round: created.id, items: data.items.length, fired: data.fire, kots: kots.map((k) => k.number) } });
        return created;
      }),
  });
  return { round: { id: round.id, itemCount: round.itemCount, fired: round.fired, replayed: round.replayed }, order: await getOrder(db as PrismaClient, ctx, orderId) };
}

/**
 * Remove a line that has NOT been sent to the kitchen (a captain's mistake
 * before "Send"). A line already on a KOT is being cooked: it is voided at the
 * KDS / by cancelling, never silently deleted here.
 */
export function removeOrderItem(ctx: AccessContext, orderItemId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const item = await tx.orderItem.findUnique({ where: { id: orderItemId }, include: { order: true, kotItems: { select: { id: true } } } });
    if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Order item not found");
    assertOutletAccess(ctx, item.outletId);
    assertCan(ctx, "order.modify", item.outletId);
    if (!["OPEN", "SENT", "PREPARING"].includes(item.order.status)) throw new ValidationError(`Cannot remove items from a ${item.order.status} order`);
    if (item.kotItems.length) throw new ValidationError("This item was already sent to the kitchen; it cannot be removed here");
    await tx.orderItem.delete({ where: { id: orderItemId } });
    const updated = await recomputeTotals(tx, item.orderId);
    await assertTotalCoversPaymentsTx(tx, item.orderId, D(updated.total));
    await writeAudit(tx, ctx, { action: "VOID", entityType: "OrderItem", entityId: orderItemId, outletId: item.outletId, before: { orderId: item.orderId, name: item.name, qty: D(item.qty).toString(), lineTotal: money(item.lineTotal).toFixed(2) } });
    return updated;
  });
}

/**
 * Captain asks for the bill: the order moves to BILLED (no further rounds —
 * the bill the guest sees cannot change under them), the table shows
 * BILL_REQUESTED and the outlet's cashiers get an in-app notification. Lines
 * never sent to the kitchen must be sent or removed first. Asking again for a
 * BILLED order is a no-op.
 */
export function requestBill(ctx: AccessContext, orderId: string, db: Client = prisma) {
  return orderTx(db, orderId, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { kotItems: { select: { id: true } } } }, table: { select: { code: true } } } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.modify", order.outletId);
    if (order.status === "BILLED") return tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!canTransition(ORDER_TRANSITIONS, order.status as OrderStatus, "BILLED")) {
      throw new ValidationError(order.status === "OPEN" ? "Send the order to the kitchen before requesting the bill" : `Cannot request the bill for a ${order.status} order`);
    }
    const unsent = order.items.filter((i) => i.kotItems.length === 0);
    if (unsent.length) throw new ValidationError(`${unsent.length} item(s) were not sent to the kitchen; send or remove them first`);
    const updated = await tx.order.update({ where: { id: orderId }, data: { status: "BILLED", billedAt: new Date() } });
    if (order.tableId) await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: "BILL_REQUESTED" } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { status: order.status }, after: { status: "BILLED", billRequested: true } });
    await createNotificationTx(tx, ctx, {
      outletId: order.outletId,
      type: "BILL_REQUESTED",
      title: order.table ? `Bill requested · table ${order.table.code}` : "Bill requested",
      body: `Order #${orderId.slice(-6).toUpperCase()} · ₹${money(order.total).toFixed(2)}`,
      dedupeWindowMinutes: 30,
    });
    return updated;
  });
}

export function cancelOrder(ctx: AccessContext, orderId: string, reason: string, db: Client = prisma) {
  return orderTx(db, orderId, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.cancel", order.outletId);
    if (!canTransition(ORDER_TRANSITIONS, order.status as OrderStatus, "CANCELLED")) {
      throw new ValidationError(`Cannot cancel an order in status ${order.status}`);
    }
    // Voiding an order that holds the guest's money would strand that money.
    const held = await heldTx(tx, orderId);
    if (held.net.gt(0)) throw new ValidationError(`This order holds ${money(held.net).toString()} in payments; refund them before cancelling`);
    const updated = await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", notes: reason } });
    // Stop the kitchen: tickets not yet READY are cancelled (READY food already exists; KOT_TRANSITIONS lets it be served/cleared).
    const live = await tx.kot.findMany({ where: { orderId, status: { in: ["NEW", "ACCEPTED", "PREPARING"] } }, select: { id: true, number: true } });
    if (live.length) {
      await tx.kot.updateMany({ where: { id: { in: live.map((k) => k.id) } }, data: { status: "CANCELLED" } });
      await tx.kotItem.updateMany({ where: { kotId: { in: live.map((k) => k.id) } }, data: { status: "CANCELLED" } });
    }
    if (order.tableId) await releaseTableTx(tx, order.tableId, orderId);
    await writeAudit(tx, ctx, { action: "VOID", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { status: order.status }, after: { reason, cancelledKots: live.map((k) => k.number) } });
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
    include: { customer: customerSelect, table: { select: { code: true } }, items: { select: { id: true, name: true, qty: true, lineTotal: true } }, kots: { select: { status: true } } },
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
    }, NEW_ORDER_TX);
  } catch (e) {
    if (data.idempotencyKey && (e as { code?: string })?.code === "P2002") {
      const prior = await replay();
      if (prior) return prior;
    }
    throw e;
  }
}
