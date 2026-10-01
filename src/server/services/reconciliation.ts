/**
 * Reconciliation engine.
 *
 * Every reconciliation kind is persisted in the same Reconciliation /
 * ReconciliationLine tables, keyed (outletId, businessDate, kind):
 *
 *   PAYMENTS   counted collections per method vs recorded payments (finance.ts)
 *   POS        POS provider's settled orders vs local orders
 *   GATEWAY    payment provider's settlement report vs local payments
 *   AGGREGATOR aggregator settlement report vs expected payouts (AggregatorOrder)
 *   VENDOR     vendor bills vs vendor payments (data-integrity check)
 *
 * A run creates/refreshes a DRAFT (lines are recomputed from source data) and
 * may finalize it. COMPLETED reconciliations are locked: re-running is refused.
 * On completion every exception line (MISSING / DUPLICATE / MISMATCHED /
 * UNPROCESSED …) or line whose |difference| exceeds tolerance raises a
 * RECONCILIATION_MISMATCH anomaly (once per line) via raiseAnomaly.
 *
 * Nothing is fabricated: lines come only from provider reports and local rows.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { raiseAnomaly } from "@/server/services/anomaly";
import { getPOSProvider, type POSProvider, type NormalizedOrder } from "@/integrations/pos";
import { getPaymentProvider, type PaymentProvider } from "@/integrations/payment";
import { getAggregatorProvider, type AggregatorProvider } from "@/integrations/aggregator";
import { processPOSOrder } from "@/server/services/pos";
import { D, money, num } from "@/domain/money";
import { outletBusinessDay, type BusinessDateInput } from "@/server/services/businessDay";

export type ReconciliationKind = "PAYMENTS" | "POS" | "GATEWAY" | "AGGREGATOR" | "VENDOR";
export const RECON_RULES = { mismatchTolerance: 1 };

/**
 * Line statuses are stored as the prefix of ReconciliationLine.note ("STATUS" or
 * "STATUS:detail"). PAYMENTS lines carry free-text notes and are judged by
 * their difference only.
 */
const OK_STATUSES = new Set(["MATCHED", "IMPORTED", "SUMMARY"]);
const EXCEPTION_STATUSES = new Set(["MISSING", "MISSING_LOCAL", "MISSING_AT_PROVIDER", "EXTRA_LOCAL", "DUPLICATE", "MISMATCHED", "UNPROCESSED"]);

export type ReconLineInput = { method: string; expected: number; actual: number; note?: string };

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}


function isException(line: { note: string | null; difference: Parameters<typeof D>[0] }) {
  const status = (line.note ?? "").split(":")[0];
  if (EXCEPTION_STATUSES.has(status)) return true;
  if (OK_STATUSES.has(status)) return false;
  return D(line.difference).abs().gt(RECON_RULES.mismatchTolerance);
}

/**
 * Create or refresh the DRAFT reconciliation for (outlet, day, kind) with the
 * given lines. Refuses to touch a COMPLETED one. Caller authorizes.
 */
export async function saveReconciliationTx(tx: Tx, ctx: AccessContext, args: { outletId: string; businessDate: BusinessDateInput; kind: ReconciliationKind; lines: ReconLineInput[]; notes?: string }) {
  const bd = await outletBusinessDay(tx, ctx, args.outletId, args.businessDate);
  const day = bd.key; // canonical: UTC midnight of the outlet-local calendar date
  const key = { outletId_businessDate_kind: { outletId: args.outletId, businessDate: day, kind: args.kind } };
  const existing = await tx.reconciliation.findUnique({ where: key });
  if (existing && existing.organizationId !== ctx.organizationId) throw new NotFoundError("Reconciliation not found");
  if (existing?.status === "COMPLETED") throw new ValidationError(`${args.kind} reconciliation for this date is already completed and locked`);
  const recon = existing
    ? await tx.reconciliation.update({ where: { id: existing.id }, data: { notes: args.notes, createdById: actor(ctx) } })
    : await tx.reconciliation.create({ data: { organizationId: ctx.organizationId, outletId: args.outletId, businessDate: day, kind: args.kind, status: "DRAFT", notes: args.notes, createdById: actor(ctx) } });
  // DRAFT lines are a working sheet recomputed from source data; they freeze on completion.
  await tx.reconciliationLine.deleteMany({ where: { reconciliationId: recon.id } });
  for (const l of args.lines) {
    const expected = money(l.expected);
    const actual = money(l.actual);
    await tx.reconciliationLine.create({ data: { organizationId: ctx.organizationId, reconciliationId: recon.id, method: l.method, expected, actual, difference: money(actual.minus(expected)), note: l.note } });
  }
  await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Reconciliation", entityId: recon.id, outletId: args.outletId, after: { kind: args.kind, businessDate: bd.date, timezone: bd.tz, status: "DRAFT", lines: args.lines.length } });
  return recon;
}

/** Lock a DRAFT reconciliation and raise an anomaly for every exception line. Caller authorizes. */
export async function completeReconciliationTx(tx: Tx, ctx: AccessContext, reconciliationId: string) {
  const recon = await tx.reconciliation.findUnique({ where: { id: reconciliationId }, include: { lines: true } });
  if (!recon || recon.organizationId !== ctx.organizationId) throw new NotFoundError("Reconciliation not found");
  assertOutletAccess(ctx, recon.outletId);
  assertCan(ctx, "finance.reconcile", recon.outletId);
  if (recon.status === "COMPLETED") throw new ValidationError("Reconciliation is already completed");
  const exceptions = recon.lines.filter(isException);
  await tx.reconciliation.update({ where: { id: recon.id }, data: { status: "COMPLETED" } });
  await writeAudit(tx, ctx, {
    action: "APPROVE", entityType: "Reconciliation", entityId: recon.id, outletId: recon.outletId, before: { status: recon.status },
    after: { kind: recon.kind, status: "COMPLETED", exceptions: exceptions.map((l) => ({ ref: l.method, status: l.note, difference: num(l.difference) })) },
  });
  const date = recon.businessDate.toISOString().slice(0, 10);
  for (const l of exceptions) {
    const diff = D(l.difference).abs();
    await raiseAnomaly(tx, ctx, {
      type: "RECONCILIATION_MISMATCH", severity: diff.gt(1000) ? "HIGH" : "MEDIUM", outletId: recon.outletId, entityType: "ReconciliationLine", entityId: l.id,
      message: `${recon.kind} ${date}: ${l.method} ${l.note ? `${l.note} ` : ""}(expected ₹${num(l.expected)}, actual ₹${num(l.actual)})`,
    });
  }
  return tx.reconciliation.findUniqueOrThrow({ where: { id: recon.id }, include: { lines: true } });
}

export async function completeReconciliation(ctx: AccessContext, reconciliationId: string, db: Client = prisma) {
  return runInTx(db, (tx) => completeReconciliationTx(tx, ctx, reconciliationId));
}

export async function getReconciliation(db: PrismaClient, ctx: AccessContext, args: { outletId: string; businessDate: BusinessDateInput; kind: ReconciliationKind }) {
  assertOutletAccess(ctx, args.outletId);
  assertCan(ctx, "finance.view", args.outletId);
  const { key } = await outletBusinessDay(db, ctx, args.outletId, args.businessDate);
  const r = await db.reconciliation.findUnique({ where: { outletId_businessDate_kind: { outletId: args.outletId, businessDate: key, kind: args.kind } }, include: { lines: { orderBy: { method: "asc" } } } });
  return r && r.organizationId === ctx.organizationId ? r : null;
}

export async function listReconciliations(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; kind?: ReconciliationKind; take?: number; cursor?: string }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "finance.view", filter.outletId);
  const take = Math.min(filter.take ?? 50, 200);
  const rows = await db.reconciliation.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(filter.kind ? { kind: filter.kind } : {}) },
    orderBy: [{ businessDate: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

type RunOpts = { outletId: string; businessDate: BusinessDateInput; finalize?: boolean };

async function persist(ctx: AccessContext, opts: RunOpts, kind: ReconciliationKind, lines: ReconLineInput[], db: Client, notes?: string) {
  return runInTx(db, async (tx) => {
    const recon = await saveReconciliationTx(tx, ctx, { outletId: opts.outletId, businessDate: opts.businessDate, kind, lines, notes });
    if (opts.finalize) return completeReconciliationTx(tx, ctx, recon.id);
    return tx.reconciliation.findUniqueOrThrow({ where: { id: recon.id }, include: { lines: true } });
  });
}

function authorize(ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.reconcile", outletId);
}

// ============================================================
// POS: provider's settled orders vs local orders
// ============================================================

export type ReconReport = {
  provider: string;
  outletId: string;
  range: { from: string; to: string };
  providerCount: number;
  localCount: number;
  missing: string[]; // externalRefs present at provider, absent locally
  extra: string[]; // externalRefs present locally, absent at provider
  duplicate: string[]; // externalRefs with >1 local order (or >1 provider row)
  changed: Array<{ externalRef: string; providerTotal: number; localTotal: number }>;
  unprocessed: string[]; // local PAID orders not yet stock-consumed
  imported: string[]; // externalRefs imported during this run (if autoImport)
};

export async function reconcilePOSOrders(
  ctx: AccessContext,
  args: { outletId: string; providerName?: string; from: Date; to: Date; autoImport?: boolean },
  opts: { provider?: POSProvider; db?: PrismaClient } = {}
): Promise<ReconReport> {
  const db = opts.db ?? prisma;
  authorize(ctx, args.outletId);
  const provider = opts.provider ?? getPOSProvider(args.providerName);

  const providerOrders = await provider.getSettledOrders({ from: args.from, to: args.to, outletId: args.outletId });
  const localOrders = await db.order.findMany({
    where: {
      organizationId: ctx.organizationId,
      outletId: args.outletId,
      source: provider.name === "mock" ? undefined : provider.name.toUpperCase(),
      createdAt: { gte: args.from, lte: args.to },
      externalRef: { not: null },
    },
  });

  const localByRef = new Map<string, typeof localOrders>();
  for (const o of localOrders) (localByRef.get(o.externalRef!) ?? localByRef.set(o.externalRef!, []).get(o.externalRef!)!).push(o);

  const missing: string[] = [];
  const changed: ReconReport["changed"] = [];
  const duplicate = new Set<string>();
  const imported: string[] = [];
  const seenAtProvider = new Set<string>();

  for (const po of providerOrders) {
    if (seenAtProvider.has(po.externalRef)) {
      duplicate.add(po.externalRef);
      continue;
    }
    seenAtProvider.add(po.externalRef);
    const locals = localByRef.get(po.externalRef);
    if (!locals || locals.length === 0) {
      missing.push(po.externalRef);
      if (args.autoImport) {
        const res = await processPOSOrder(ctx, po as NormalizedOrder, db);
        if (!res.duplicate) imported.push(po.externalRef);
      }
      continue;
    }
    if (locals.length > 1) duplicate.add(po.externalRef);
    if (po.total !== undefined && !D(locals[0].total).eq(D(po.total))) {
      changed.push({ externalRef: po.externalRef, providerTotal: po.total, localTotal: num(locals[0].total) });
    }
  }

  const extra = [...localByRef.keys()].filter((ref) => !seenAtProvider.has(ref));
  const unprocessed = localOrders.filter((o) => !o.stockConsumed && o.status === "PAID").map((o) => o.externalRef!);

  return {
    provider: provider.name,
    outletId: args.outletId,
    range: { from: args.from.toISOString(), to: args.to.toISOString() },
    providerCount: providerOrders.length,
    localCount: localOrders.length,
    missing,
    extra,
    duplicate: [...duplicate],
    changed,
    unprocessed,
    imported,
  };
}

/** Run the POS reconciliation for a business day and persist it (kind POS). */
export async function runPOSReconciliation(ctx: AccessContext, opts: RunOpts & { autoImport?: boolean; provider?: POSProvider; providerName?: string }, db: PrismaClient = prisma) {
  authorize(ctx, opts.outletId);
  const { start, end } = await outletBusinessDay(db, ctx, opts.outletId, opts.businessDate);
  const provider = opts.provider ?? getPOSProvider(opts.providerName);
  const report = await reconcilePOSOrders(ctx, { outletId: opts.outletId, from: start, to: new Date(end.getTime() - 1), autoImport: opts.autoImport }, { provider, db });
  const providerOrders = await provider.getSettledOrders({ from: start, to: new Date(end.getTime() - 1), outletId: opts.outletId });
  const totalOf = (ref: string) => providerOrders.find((o) => o.externalRef === ref)?.total ?? 0;
  const local = await db.order.findMany({ where: { organizationId: ctx.organizationId, outletId: opts.outletId, externalRef: { in: [...new Set([...report.extra, ...report.unprocessed, ...report.duplicate])] } }, select: { externalRef: true, total: true } });
  const localTotal = (ref: string) => num(local.find((o) => o.externalRef === ref)?.total ?? 0);

  const lines: ReconLineInput[] = [];
  const imported = new Set(report.imported);
  for (const ref of report.missing) lines.push({ method: `order:${ref}`, expected: totalOf(ref), actual: imported.has(ref) ? totalOf(ref) : 0, note: imported.has(ref) ? "IMPORTED" : "MISSING" });
  for (const ref of report.extra) lines.push({ method: `order:${ref}`, expected: 0, actual: localTotal(ref), note: "EXTRA_LOCAL" });
  for (const ref of report.duplicate) lines.push({ method: `order:${ref}`, expected: totalOf(ref), actual: localTotal(ref), note: "DUPLICATE" });
  for (const c of report.changed) lines.push({ method: `order:${c.externalRef}`, expected: c.providerTotal, actual: c.localTotal, note: "MISMATCHED" });
  for (const ref of report.unprocessed) lines.push({ method: `order:${ref}`, expected: localTotal(ref), actual: localTotal(ref), note: "UNPROCESSED:stock not consumed" });
  const providerSum = providerOrders.reduce((s, o) => s.plus(o.total ?? 0), D(0));
  lines.push({ method: "TOTAL", expected: num(providerSum), actual: num(providerSum), note: `SUMMARY:${report.providerCount} provider / ${report.localCount} local orders` });
  const recon = await persist(ctx, opts, "POS", lines, db, `provider=${report.provider}`);
  return { report, reconciliation: recon };
}

// ============================================================
// GATEWAY: payment provider settlement vs local payments
// ============================================================

/**
 * Compare the gateway's settlement report with local payments of that provider
 * for the business day. Exceptions: MISSING_LOCAL (captured at the gateway, no
 * local payment), MISSING_AT_PROVIDER (local SUCCESS the gateway never
 * captured), MISMATCHED (amount/status), DUPLICATE (repeated gateway row),
 * UNPROCESSED (captured at the gateway but still PENDING locally).
 */
export async function runPaymentReconciliation(ctx: AccessContext, opts: RunOpts & { provider?: PaymentProvider; providerName?: string }, db: PrismaClient = prisma) {
  authorize(ctx, opts.outletId);
  const provider = opts.provider ?? getPaymentProvider(opts.providerName);
  if (!provider.getSettlements) throw new ValidationError(`Payment provider ${provider.name} does not expose a settlement report`);
  const { start, end } = await outletBusinessDay(db, ctx, opts.outletId, opts.businessDate);
  const range = { from: start, to: new Date(end.getTime() - 1) };
  const rows = await provider.getSettlements(range);
  const refs = [...new Set(rows.map((r) => r.providerRef))];
  const local = await db.payment.findMany({
    where: {
      organizationId: ctx.organizationId,
      OR: [{ provider: provider.name, outletId: opts.outletId, createdAt: { gte: range.from, lte: range.to } }, { provider: provider.name, providerRef: { in: refs } }],
    },
  });
  const localByRef = new Map(local.filter((p) => p.providerRef).map((p) => [p.providerRef!, p]));
  const lines: ReconLineInput[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.providerRef)) {
      lines.push({ method: `payment:${r.providerRef}`, expected: r.amount, actual: 0, note: "DUPLICATE:repeated in gateway report" });
      continue;
    }
    seen.add(r.providerRef);
    const p = localByRef.get(r.providerRef);
    if (p && p.outletId !== opts.outletId) continue; // belongs to another outlet's reconciliation
    if (r.status !== "CAPTURED") {
      if (p && p.status === "SUCCESS") lines.push({ method: `payment:${r.providerRef}`, expected: 0, actual: num(p.amount), note: `MISMATCHED:gateway ${r.status}, local SUCCESS` });
      continue;
    }
    if (!p) lines.push({ method: `payment:${r.providerRef}`, expected: r.amount, actual: 0, note: "MISSING_LOCAL" });
    else if (p.status === "PENDING") lines.push({ method: `payment:${r.providerRef}`, expected: r.amount, actual: 0, note: "UNPROCESSED:captured at gateway, pending locally" });
    else if (p.status === "FAILED") lines.push({ method: `payment:${r.providerRef}`, expected: r.amount, actual: 0, note: "MISMATCHED:captured at gateway, failed locally" });
    else if (!D(p.amount).eq(D(r.amount))) lines.push({ method: `payment:${r.providerRef}`, expected: r.amount, actual: num(p.amount), note: "MISMATCHED" });
  }
  for (const p of local) {
    if (p.outletId !== opts.outletId || p.status !== "SUCCESS" || !p.providerRef || seen.has(p.providerRef)) continue;
    if (p.createdAt < range.from || p.createdAt > range.to) continue;
    lines.push({ method: `payment:${p.providerRef}`, expected: 0, actual: num(p.amount), note: "MISSING_AT_PROVIDER" });
  }
  const captured = rows.filter((r) => r.status === "CAPTURED").reduce((s, r) => s.plus(r.amount), D(0));
  const localSuccess = local.filter((p) => p.outletId === opts.outletId && p.status !== "PENDING" && p.status !== "FAILED" && p.createdAt >= range.from && p.createdAt <= range.to).reduce((s, p) => s.plus(D(p.amount)), D(0));
  lines.push({ method: "TOTAL", expected: num(captured), actual: num(localSuccess), note: `SUMMARY:${rows.length} gateway rows / ${local.length} local payments` });
  return persist(ctx, opts, "GATEWAY", lines, db, `provider=${provider.name}`);
}

// ============================================================
// AGGREGATOR: settlement report vs expected payouts
// ============================================================

/**
 * Compare an aggregator's settlement report for the day with the expected
 * payouts recorded on AggregatorOrder rows (created when aggregator orders are
 * ingested). Also records an AggregatorSettlement summary row. Exceptions:
 * MISSING (expected payout, nothing settled), MISSING_LOCAL (settled, unknown
 * order), DUPLICATE, MISMATCHED (payout differs), UNPROCESSED (aggregator order
 * never linked to an internal order).
 */
export async function runAggregatorReconciliation(ctx: AccessContext, opts: RunOpts & { aggregatorId: string; provider?: AggregatorProvider }, db: PrismaClient = prisma) {
  authorize(ctx, opts.outletId);
  const aggregator = await db.aggregator.findUnique({ where: { id: opts.aggregatorId } });
  if (!aggregator || aggregator.organizationId !== ctx.organizationId) throw new NotFoundError("Aggregator not found");
  const provider = opts.provider ?? getAggregatorProvider(aggregator.name);
  const { start, end } = await outletBusinessDay(db, ctx, opts.outletId, opts.businessDate);
  const range = { from: start, to: new Date(end.getTime() - 1) };
  const rows = await provider.getSettlements({ ...range, outletId: opts.outletId });
  const expected = await db.aggregatorOrder.findMany({ where: { organizationId: ctx.organizationId, outletId: opts.outletId, aggregatorId: aggregator.id, placedAt: { gte: range.from, lte: range.to } } });
  const knownIds = [...new Set(rows.map((r) => r.externalId))];
  const knownElsewhere = await db.aggregatorOrder.findMany({ where: { aggregatorId: aggregator.id, externalId: { in: knownIds } } });
  const byExt = new Map([...knownElsewhere, ...expected].map((o) => [o.externalId, o]));

  const lines: ReconLineInput[] = [];
  const seen = new Set<string>();
  let actualTotal = D(0);
  for (const r of rows) {
    if (seen.has(r.externalId)) {
      lines.push({ method: `agg:${r.externalId}`, expected: 0, actual: r.netPayout, note: "DUPLICATE:repeated in settlement" });
      continue;
    }
    seen.add(r.externalId);
    actualTotal = actualTotal.plus(r.netPayout);
    const o = byExt.get(r.externalId);
    if (!o) lines.push({ method: `agg:${r.externalId}`, expected: 0, actual: r.netPayout, note: "MISSING_LOCAL" });
    else if (!D(o.netPayout).eq(D(r.netPayout))) lines.push({ method: `agg:${r.externalId}`, expected: num(o.netPayout), actual: r.netPayout, note: "MISMATCHED" });
  }
  let expectedTotal = D(0);
  for (const o of expected) {
    expectedTotal = expectedTotal.plus(D(o.netPayout));
    if (!seen.has(o.externalId)) lines.push({ method: `agg:${o.externalId}`, expected: num(o.netPayout), actual: 0, note: "MISSING" });
    if (!o.orderId) lines.push({ method: `agg:${o.externalId}:link`, expected: num(o.netPayout), actual: num(o.netPayout), note: "UNPROCESSED:no internal order" });
  }
  lines.push({ method: "TOTAL", expected: num(expectedTotal), actual: num(actualTotal), note: `SUMMARY:${expected.length} expected / ${rows.length} settled` });

  return runInTx(db, async (tx) => {
    await tx.aggregatorSettlement.create({
      data: { organizationId: ctx.organizationId, outletId: opts.outletId, aggregatorId: aggregator.id, periodFrom: range.from, periodTo: range.to, expectedPayout: money(expectedTotal), actualPayout: money(actualTotal), difference: money(actualTotal.minus(expectedTotal)) },
    });
    const recon = await saveReconciliationTx(tx, ctx, { outletId: opts.outletId, businessDate: opts.businessDate, kind: "AGGREGATOR", lines, notes: `aggregator=${aggregator.name}` });
    if (opts.finalize) return completeReconciliationTx(tx, ctx, recon.id);
    return tx.reconciliation.findUniqueOrThrow({ where: { id: recon.id }, include: { lines: true } });
  });
}

// ============================================================
// VENDOR: bills vs vendor payments
// ============================================================

/**
 * Integrity check of an outlet's payables as of a date: each bill's cached
 * paidAmount must equal the sum of its payments; no bill may be overpaid; no
 * payment may sit on a cancelled bill. Payments with no bill are flagged
 * UNPROCESSED (unallocated); repeated (vendor, amount, reference) payments are
 * flagged DUPLICATE.
 */
export async function runVendorPaymentReconciliation(ctx: AccessContext, opts: RunOpts, db: PrismaClient = prisma) {
  authorize(ctx, opts.outletId);
  const { end } = await outletBusinessDay(db, ctx, opts.outletId, opts.businessDate);
  const bills = await db.purchaseBill.findMany({
    where: { organizationId: ctx.organizationId, outletId: opts.outletId, createdAt: { lt: end } },
    select: { id: true, number: true, status: true, total: true, paidAmount: true, payments: { select: { amount: true } } },
  });
  const lines: ReconLineInput[] = [];
  for (const b of bills) {
    const paid = b.payments.reduce((s, p) => s.plus(D(p.amount)), D(0));
    if (b.status === "CANCELLED" && b.payments.length) lines.push({ method: `bill:${b.number}`, expected: 0, actual: num(paid), note: "MISMATCHED:payment on cancelled bill" });
    else if (!paid.eq(D(b.paidAmount))) lines.push({ method: `bill:${b.number}`, expected: num(paid), actual: num(b.paidAmount), note: "MISMATCHED:paidAmount differs from payments" });
    else if (paid.gt(D(b.total))) lines.push({ method: `bill:${b.number}`, expected: num(b.total), actual: num(paid), note: "MISMATCHED:overpaid" });
  }
  const payments = await db.vendorPayment.findMany({ where: { organizationId: ctx.organizationId, outletId: opts.outletId, createdAt: { lt: end } }, orderBy: { createdAt: "asc" } });
  const seen = new Map<string, string>();
  for (const p of payments) {
    if (!p.billId) lines.push({ method: `vpay:${p.id}`, expected: 0, actual: num(p.amount), note: "UNPROCESSED:not allocated to a bill" });
    if (p.reference) {
      const k = `${p.vendorId}|${D(p.amount).toString()}|${p.reference}`;
      if (seen.has(k)) lines.push({ method: `vpay:${p.id}`, expected: 0, actual: num(p.amount), note: `DUPLICATE:same vendor/amount/reference as ${seen.get(k)}` });
      else seen.set(k, p.id);
    }
  }
  const billed = bills.filter((b) => b.status !== "CANCELLED").reduce((s, b) => s.plus(D(b.total)), D(0));
  const paidTotal = payments.reduce((s, p) => s.plus(D(p.amount)), D(0));
  lines.push({ method: "TOTAL", expected: num(billed), actual: num(paidTotal), note: `SUMMARY:${bills.length} bills / ${payments.length} payments (due ${num(billed.minus(paidTotal))})` });
  return persist(ctx, opts, "VENDOR", lines, db);
}
