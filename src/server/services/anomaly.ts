/**
 * Rule-based anomaly engine. Detectors read real data and raise anomalies only
 * when a rule actually fires (nothing manufactured for dashboards).
 *
 * Raising (`raiseAnomaly`) is shared by every service that detects a problem
 * (detectors here, finance reconciliation / cash drawer, …) and is idempotent:
 *
 *   recurrence "ONCE"             — the anomaly is about one specific event row
 *                                   (a GRN line, a count line, a reconciliation
 *                                   line). It is raised at most once, ever; a
 *                                   resolved/dismissed one is never re-raised.
 *   recurrence "WHILE_UNRESOLVED" — the anomaly is about an ongoing condition
 *                                   (negative stock, heavy wastage). An OPEN or
 *                                   ACKNOWLEDGED one is reused. After it is
 *                                   resolved/dismissed it is raised again only if
 *                                   there is new evidence (`evidenceAt`) newer
 *                                   than that resolution.
 *
 * Status changes follow ANOMALY_TRANSITIONS and are audited.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AnomalySeverity, AnomalyStatus, AnomalyType, ANOMALY_TRANSITIONS, type AnomalyStatus as AnomalyStatusT } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError, ValidationError, ForbiddenError, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx, assertTransition } from "@/server/services/_workflow";
import { negativeStock } from "@/server/services/inventory";
import { createNotificationTx } from "@/server/services/notifications";
import { D, num } from "@/domain/money";

export const ANOMALY_RULES = {
  heavyWastageAmount: 1000, // ₹ within lookback
  wastageLookbackDays: 7,
  priceSpikePct: 25, // % above prior average purchase rate
  priceLookbackDays: 90,
  countVarianceQty: 5, // absolute variance units
  countVarianceCost: 500, // ₹ absolute cost impact
  countLookbackDays: 30,
  /** Upper bound on rows any single detector scans per run. */
  scanLimit: 500,
};

const UNRESOLVED: AnomalyStatusT[] = ["OPEN", "ACKNOWLEDGED"];

const raiseSchema = z.object({
  type: AnomalyType.zod,
  severity: AnomalySeverity.zod,
  outletId: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  message: z.string().min(1),
  recurrence: z.enum(["ONCE", "WHILE_UNRESOLVED"]).default("ONCE"),
  /** For WHILE_UNRESOLVED: time of the newest evidence for the condition. */
  evidenceAt: z.date().optional(),
});
export type RaiseAnomalyInput = z.input<typeof raiseSchema>;
export type RaiseResult = { anomaly: Awaited<ReturnType<Tx["anomaly"]["create"]>>; created: boolean };

/**
 * Raise (or reuse) an anomaly inside the caller's transaction. Validates the
 * outlet against the org and the actor's scope, writes an audit row and an
 * in-app notification when a new anomaly is created.
 */
export async function raiseAnomaly(tx: Tx, ctx: AccessContext, input: RaiseAnomalyInput): Promise<RaiseResult> {
  const a = raiseSchema.parse(input);
  if (a.outletId) {
    const outlet = await tx.outlet.findUnique({ where: { id: a.outletId }, select: { organizationId: true } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new ForbiddenError("Outlet is outside this organization");
    assertOutletAccess(ctx, a.outletId);
  }
  const key = { organizationId: ctx.organizationId, type: a.type, outletId: a.outletId ?? null, entityType: a.entityType ?? null, entityId: a.entityId ?? null };

  if (a.recurrence === "ONCE") {
    const existing = await tx.anomaly.findFirst({ where: key, orderBy: { detectedAt: "asc" } });
    if (existing) return { anomaly: existing, created: false };
  } else {
    const open = await tx.anomaly.findFirst({ where: { ...key, status: { in: UNRESOLVED } }, orderBy: { detectedAt: "desc" } });
    if (open) return { anomaly: open, created: false };
    const closed = await tx.anomaly.findFirst({ where: { ...key, status: { notIn: UNRESOLVED } }, orderBy: { resolvedAt: "desc" } });
    // The last resolution already covered all evidence up to its time.
    if (closed?.resolvedAt && (!a.evidenceAt || a.evidenceAt <= closed.resolvedAt)) return { anomaly: closed, created: false };
  }

  const anomaly = await tx.anomaly.create({
    data: { ...key, outletId: a.outletId, severity: a.severity, message: a.message, status: "OPEN" },
  });
  await writeAudit(tx, ctx, { action: "CREATE", entityType: "Anomaly", entityId: anomaly.id, outletId: a.outletId, after: { type: a.type, severity: a.severity, entityType: a.entityType, entityId: a.entityId, message: a.message } });
  await createNotificationTx(tx, ctx, { outletId: a.outletId, type: "ANOMALY", title: `Anomaly: ${a.type}`, body: a.message });
  return { anomaly, created: true };
}

export type DetectedAnomaly = { type: string; id: string; created: boolean };

/** Run all detectors for the caller's outlets (or one outlet). Returns every anomaly that fired. */
export async function detectAnomalies(ctx: AccessContext, opts: { outletId?: string } = {}, db: Client = prisma): Promise<DetectedAnomaly[]> {
  if (opts.outletId) assertOutletAccess(ctx, opts.outletId);
  assertCan(ctx, "anomaly.view", opts.outletId);
  const outletIds = opts.outletId ? [opts.outletId] : ctx.outletIds;
  return runInTx(db, async (tx) => {
    const found: DetectedAnomaly[] = [];
    const push = (type: string, r: RaiseResult) => found.push({ type, id: r.anomaly.id, created: r.created });
    if (!outletIds.length) return found;
    const now = Date.now();

    // 1. Negative stock (condition).
    for (const outletId of outletIds) {
      for (const n of await negativeStock(tx, ctx, outletId)) {
        const last = await tx.inventoryLedger.findFirst({ where: { organizationId: ctx.organizationId, outletId, materialId: n.materialId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        push("NEGATIVE_STOCK", await raiseAnomaly(tx, ctx, { type: "NEGATIVE_STOCK", severity: "HIGH", recurrence: "WHILE_UNRESOLVED", evidenceAt: last?.createdAt, outletId, entityType: "Material", entityId: n.materialId, message: `Negative stock ${num(n.quantity)} for material ${n.materialId}` }));
      }
    }

    // 2. Unmapped POS sales (one event per queue row).
    const unmapped = await tx.unmappedSale.findMany({ where: { organizationId: ctx.organizationId, status: "OPEN", outletId: { in: outletIds } }, orderBy: { firstSeenAt: "asc" }, take: ANOMALY_RULES.scanLimit });
    for (const u of unmapped) {
      push("UNMAPPED_ITEM", await raiseAnomaly(tx, ctx, { type: "UNMAPPED_ITEM", severity: "MEDIUM", outletId: u.outletId, entityType: "UnmappedSale", entityId: u.id, message: `Sold item "${u.posName ?? ""}" (${u.posCode}) has no recipe mapping` }));
    }

    // 3. Heavy wastage in the lookback window (condition).
    const wasteSince = new Date(now - ANOMALY_RULES.wastageLookbackDays * 86400000);
    for (const outletId of outletIds) {
      const where = { organizationId: ctx.organizationId, outletId, txnType: { in: ["WASTAGE", "SPOILAGE"] }, createdAt: { gte: wasteSince } };
      const agg = await tx.inventoryLedger.aggregate({ where, _sum: { amount: true }, _max: { createdAt: true } });
      const wasted = D(agg._sum.amount ?? 0).abs();
      if (wasted.gt(ANOMALY_RULES.heavyWastageAmount)) {
        push("HEAVY_WASTAGE", await raiseAnomaly(tx, ctx, { type: "HEAVY_WASTAGE", severity: "MEDIUM", recurrence: "WHILE_UNRESOLVED", evidenceAt: agg._max.createdAt ?? undefined, outletId, entityType: "Outlet", entityId: outletId, message: `Wastage ₹${num(wasted)} in last ${ANOMALY_RULES.wastageLookbackDays} days` }));
      }
    }

    // 4. Vendor price spike: newest posted GRN rate per material vs the prior average (one event per GRN line).
    const priceSince = new Date(now - ANOMALY_RULES.priceLookbackDays * 86400000);
    const receipts = await tx.goodsReceiptLine.findMany({
      where: { organizationId: ctx.organizationId, rate: { gt: 0 }, grn: { status: "POSTED", outletId: { in: outletIds }, receivedAt: { gte: priceSince } } },
      select: { id: true, materialId: true, rate: true, grn: { select: { outletId: true, vendorId: true, number: true, receivedAt: true } } },
      orderBy: [{ grn: { receivedAt: "desc" } }, { id: "desc" }],
      take: ANOMALY_RULES.scanLimit,
    });
    const byKey = new Map<string, typeof receipts>();
    for (const r of receipts) {
      const k = `${r.grn.outletId}:${r.materialId}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
    }
    for (const lines of byKey.values()) {
      if (lines.length < 2) continue;
      const [latest, ...prior] = lines;
      const avgPrior = prior.reduce((s, l) => s.plus(D(l.rate)), D(0)).div(prior.length);
      const spikePct = D(latest.rate).minus(avgPrior).div(avgPrior).times(100);
      if (spikePct.gte(ANOMALY_RULES.priceSpikePct)) {
        push("PRICE_SPIKE", await raiseAnomaly(tx, ctx, { type: "PRICE_SPIKE", severity: spikePct.gte(50) ? "HIGH" : "MEDIUM", outletId: latest.grn.outletId, entityType: "GoodsReceiptLine", entityId: latest.id, message: `Vendor ${latest.grn.vendorId} rate ${num(latest.rate)} on ${latest.grn.number} is ${num(spikePct.toDecimalPlaces(1))}% above prior avg ${num(avgPrior.toDecimalPlaces(2))} for material ${latest.materialId}` }));
      }
    }

    // 5. Large variances on recently approved stock counts (one event per count line).
    const countSince = new Date(now - ANOMALY_RULES.countLookbackDays * 86400000);
    const countLines = await tx.stockCountLine.findMany({
      where: { organizationId: ctx.organizationId, count: { status: "APPROVED", outletId: { in: outletIds }, approvedAt: { gte: countSince } } },
      include: { count: { select: { outletId: true, number: true } } },
      orderBy: { id: "asc" },
      take: ANOMALY_RULES.scanLimit,
    });
    for (const line of countLines) {
      const qtyHit = D(line.variance).abs().gte(ANOMALY_RULES.countVarianceQty);
      const costHit = D(line.costImpact).abs().gte(ANOMALY_RULES.countVarianceCost);
      if (qtyHit || costHit) {
        push("COUNT_VARIANCE", await raiseAnomaly(tx, ctx, { type: "COUNT_VARIANCE", severity: costHit ? "HIGH" : "MEDIUM", outletId: line.count.outletId, entityType: "StockCountLine", entityId: line.id, message: `Count ${line.count.number}: variance ${num(line.variance)} (₹${num(line.costImpact)}) for material ${line.materialId}` }));
      }
    }

    return found;
  });
}

// ---------------- Queries ----------------

const listSchema = z.object({
  outletId: z.string().optional(),
  status: AnomalyStatus.zod.optional(),
  type: AnomalyType.zod.optional(),
  severity: AnomalySeverity.zod.optional(),
  take: z.coerce.number().int().positive().max(200).default(50), // query strings arrive as text
  /** id of the last row from the previous page. */
  cursor: z.string().optional(),
});

/** where-clause fragment: anomalies the actor may see. Org-level (outlet-less) rows need an org-wide actor. */
function anomalyScope(ctx: AccessContext, outletId?: string) {
  if (outletId) return { organizationId: ctx.organizationId, outletId };
  if (ctx.isSuperAdmin || ctx.isOrgWide) return { organizationId: ctx.organizationId };
  return { organizationId: ctx.organizationId, outletId: { in: ctx.outletIds } };
}

/**
 * Cursor-paginated, deterministic listing (detectedAt desc, id desc), scoped to
 * the organization and the actor's accessible outlets.
 */
export async function listAnomalies(db: PrismaClient, ctx: AccessContext, filter: z.input<typeof listSchema> = {}) {
  const f = listSchema.parse(filter);
  if (f.outletId) assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "anomaly.view", f.outletId);
  const rows = await db.anomaly.findMany({
    where: { ...anomalyScope(ctx, f.outletId), ...(f.status ? { status: f.status } : {}), ...(f.type ? { type: f.type } : {}), ...(f.severity ? { severity: f.severity } : {}) },
    orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
    take: f.take + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, f.take);
  return { items, nextCursor: rows.length > f.take ? items[items.length - 1].id : null };
}

async function loadScoped(tx: Tx | PrismaClient, ctx: AccessContext, anomalyId: string) {
  const anomaly = await tx.anomaly.findUnique({ where: { id: anomalyId } });
  // Cross-org rows are reported as not found (no existence leak).
  if (!anomaly || anomaly.organizationId !== ctx.organizationId) throw new NotFoundError("Anomaly not found");
  if (anomaly.outletId) assertOutletAccess(ctx, anomaly.outletId);
  else if (!ctx.isSuperAdmin && !ctx.isOrgWide) throw new ForbiddenError("Organization-level anomaly requires an org-wide role");
  return anomaly;
}

export async function getAnomaly(db: PrismaClient, ctx: AccessContext, anomalyId: string) {
  const anomaly = await loadScoped(db, ctx, anomalyId);
  assertCan(ctx, "anomaly.view", anomaly.outletId ?? undefined);
  return anomaly;
}

// ---------------- Status transitions ----------------

type TargetStatus = Exclude<AnomalyStatusT, "OPEN">;

function setStatus(ctx: AccessContext, anomalyId: string, to: TargetStatus, note: string | undefined, db: Client) {
  return runInTx(db, async (tx) => {
    const anomaly = await loadScoped(tx, ctx, anomalyId);
    assertCan(ctx, "anomaly.resolve", anomaly.outletId ?? undefined);
    assertTransition(ANOMALY_TRANSITIONS, anomaly.status as AnomalyStatusT, to, "anomaly");
    if (to === "DISMISSED" && !note?.trim()) throw new ValidationError("Dismissing an anomaly requires a note");
    const closing = to === "RESOLVED" || to === "DISMISSED";
    const updated = await tx.anomaly.update({
      where: { id: anomalyId },
      data: {
        status: to,
        ...(note !== undefined ? { resolutionNote: note } : {}),
        ...(closing ? { resolvedById: ctx.userId === "system" ? null : ctx.userId, resolvedAt: new Date() } : {}),
      },
    });
    await writeAudit(tx, ctx, {
      action: to === "DISMISSED" ? "REJECT" : to === "RESOLVED" ? "APPROVE" : "UPDATE",
      entityType: "Anomaly",
      entityId: anomalyId,
      outletId: anomaly.outletId,
      before: { status: anomaly.status },
      after: { status: to, note },
    });
    return updated;
  });
}

export const acknowledgeAnomaly = (ctx: AccessContext, id: string, db: Client = prisma) => setStatus(ctx, id, "ACKNOWLEDGED", undefined, db);
export const resolveAnomaly = (ctx: AccessContext, id: string, note?: string, db: Client = prisma) => setStatus(ctx, id, "RESOLVED", note, db);
export const dismissAnomaly = (ctx: AccessContext, id: string, note: string, db: Client = prisma) => setStatus(ctx, id, "DISMISSED", note, db);
