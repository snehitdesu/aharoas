/**
 * Outlet-aware business days. The single place where finance, reconciliation,
 * analytics and reports turn "a day" into UTC instants, using Outlet.timezone
 * (or Organization.timezone for org-wide queries). See src/domain/time.ts.
 */
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { type AccessContext, NotFoundError } from "@/server/db/scope";
import { businessDayRange, businessDateKey, utcOffsetMinutes } from "@/domain/time";

type Db = PrismaClient | Prisma.TransactionClient;

/** Accepts "YYYY-MM-DD" (a calendar date) or an instant (mapped to its local date). */
export const businessDateInput = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.coerce.date()]);
export type BusinessDateInput = z.infer<typeof businessDateInput>;

export async function outletTimeZone(db: Db, ctx: AccessContext, outletId: string): Promise<string> {
  const outlet = await db.outlet.findUnique({ where: { id: outletId }, select: { organizationId: true, timezone: true } });
  if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
  return outlet.timezone;
}

export async function orgTimeZone(db: Db, ctx: AccessContext): Promise<string> {
  const org = await db.organization.findUnique({ where: { id: ctx.organizationId }, select: { timezone: true } });
  return org?.timezone ?? "Asia/Kolkata";
}

/** A business day at an outlet: its date, [start, end) instants and canonical key. */
export async function outletBusinessDay(db: Db, ctx: AccessContext, outletId: string, input: BusinessDateInput) {
  const tz = await outletTimeZone(db, ctx, outletId);
  const range = businessDayRange(input, tz);
  return { ...range, key: businessDateKey(range.date, tz), tz };
}

/** UTC offset (minutes) per outlet at `at` — for SQL day/hour bucketing. */
export async function outletOffsets(db: Db, ctx: AccessContext, outletIds: string[], at: Date = new Date()): Promise<Map<string, number>> {
  const outlets = await db.outlet.findMany({ where: { organizationId: ctx.organizationId, id: { in: outletIds } }, select: { id: true, timezone: true } });
  return new Map(outlets.map((o) => [o.id, utcOffsetMinutes(at, o.timezone)]));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize report/finance filters: date-only `from`/`to` strings mean whole
 * business days in the outlet's timezone (or the organization's when no outlet
 * is given): from = start of that day, to = end of that day (inclusive).
 * Full timestamps pass through unchanged.
 */
export async function resolveDateFilters<T extends { outletId?: unknown; from?: unknown; to?: unknown }>(db: Db, ctx: AccessContext, input: T): Promise<T> {
  const needs = (v: unknown) => typeof v === "string" && DATE_ONLY.test(v);
  if (!needs(input.from) && !needs(input.to)) return input;
  const tz = typeof input.outletId === "string" && input.outletId ? await outletTimeZone(db, ctx, input.outletId) : await orgTimeZone(db, ctx);
  const out: Record<string, unknown> = { ...input };
  if (needs(input.from)) out.from = businessDayRange(input.from as string, tz).start.toISOString();
  if (needs(input.to)) out.to = new Date(businessDayRange(input.to as string, tz).end.getTime() - 1).toISOString();
  return out as T;
}
