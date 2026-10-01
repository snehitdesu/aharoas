/**
 * Business-day / timezone handling: pure utility + outlet-aware finance,
 * reconciliation, analytics and reports across outlets in different zones.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { businessDayRange, businessDateKey, localDate, toBusinessDate, utcOffsetMinutes, isValidTimeZone } from "@/domain/time";
import { processPOSOrder } from "@/server/services/pos";
import { computeDailyExpected, saveDailyReconciliation, dailyClosing } from "@/server/services/finance";
import { dailySales, dayPartSales } from "@/server/services/analytics";
import { getReport } from "@/server/services/reports";

const iso = (d: Date) => d.toISOString();

describe("time utilities", () => {
  it("UTC business day", () => {
    const r = businessDayRange("2026-01-10", "UTC");
    expect([iso(r.start), iso(r.end)]).toEqual(["2026-01-10T00:00:00.000Z", "2026-01-11T00:00:00.000Z"]);
  });

  it("India (+05:30)", () => {
    const r = businessDayRange("2026-01-10", "Asia/Kolkata");
    expect([iso(r.start), iso(r.end)]).toEqual(["2026-01-09T18:30:00.000Z", "2026-01-10T18:30:00.000Z"]);
    expect(utcOffsetMinutes(new Date("2026-01-10T00:00:00Z"), "Asia/Kolkata")).toBe(330);
  });

  it("positive offset (Tokyo +09:00)", () => {
    expect(iso(businessDayRange("2026-01-10", "Asia/Tokyo").start)).toBe("2026-01-09T15:00:00.000Z");
  });

  it("negative offset with DST (New York)", () => {
    expect(iso(businessDayRange("2026-01-10", "America/New_York").start)).toBe("2026-01-10T05:00:00.000Z"); // EST -5
    expect(iso(businessDayRange("2026-07-10", "America/New_York").start)).toBe("2026-07-10T04:00:00.000Z"); // EDT -4
    const dstStart = businessDayRange("2026-03-08", "America/New_York"); // clocks spring forward
    expect((dstStart.end.getTime() - dstStart.start.getTime()) / 3600_000).toBe(23);
  });

  it("date rollover: the same instant is a different business date per zone", () => {
    const t = new Date("2026-01-10T20:00:00Z");
    expect(localDate(t, "Asia/Kolkata")).toBe("2026-01-11");
    expect(localDate(t, "America/Los_Angeles")).toBe("2026-01-10");
    expect(toBusinessDate("2026-01-10", "Pacific/Auckland")).toBe("2026-01-10"); // literal dates are never shifted
    expect(iso(businessDateKey(t, "Asia/Kolkata"))).toBe("2026-01-11T00:00:00.000Z");
  });

  it("rejects bad zones and dates", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(() => businessDayRange("2026-13-45x", "UTC")).toThrow(RangeError);
  });
});

const RUN = Date.now().toString(36);
let orgId: string, india: string, ny: string, ctx: AccessContext;
const T = new Date("2026-01-10T20:00:00Z"); // Jan 11 01:30 in India, Jan 10 15:00 in New York

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `TZ Org ${RUN}` } })).id;
  india = (await prisma.outlet.create({ data: { organizationId: orgId, code: `IN${RUN}`, name: "Bengaluru", timezone: "Asia/Kolkata" } })).id;
  ny = (await prisma.outlet.create({ data: { organizationId: orgId, code: `NY${RUN}`, name: "New York", timezone: "America/New_York" } })).id;
  ctx = systemContext(orgId, [india, ny]);
  for (const [outletId, ref] of [[india, "in"], [ny, "ny"]] as const) {
    await processPOSOrder(ctx, {
      externalRef: `${ref}-${RUN}`, eventId: `e-${ref}-${RUN}`, outletId, source: "PETPOOJA", channel: "DINE_IN", placedAt: T,
      items: [{ posItemCode: "X", name: "Meal", qty: 1, unitPrice: 500 }], payments: [{ method: "CASH", amount: 500 }], settled: true,
    });
  }
});

afterAll(async () => { await prisma.$disconnect(); });

describe("multi-outlet business days", () => {
  it("daily sales and day-parts bucket each outlet in its own timezone", async () => {
    const rows = await dailySales(prisma, ctx, { from: new Date("2026-01-09T00:00:00Z"), to: new Date("2026-01-12T00:00:00Z") });
    expect(rows.find((r) => r.outletId === india)?.day).toBe("2026-01-11");
    expect(rows.find((r) => r.outletId === ny)?.day).toBe("2026-01-10");
    const parts = await dayPartSales(prisma, ctx, { outletId: india, from: new Date("2026-01-09T00:00:00Z"), to: new Date("2026-01-12T00:00:00Z") });
    expect(parts.map((p) => p.hour)).toEqual([1]);
    expect((await dayPartSales(prisma, ctx, { outletId: ny, from: new Date("2026-01-09T00:00:00Z"), to: new Date("2026-01-12T00:00:00Z") })).map((p) => p.hour)).toEqual([15]);
  });

  it("expected collections use the outlet's business day", async () => {
    expect(await computeDailyExpected(prisma, ctx, india, "2026-01-11")).toEqual([{ method: "CASH", expected: 500 }]);
    expect(await computeDailyExpected(prisma, ctx, india, "2026-01-10")).toEqual([]);
    expect(await computeDailyExpected(prisma, ctx, ny, "2026-01-10")).toEqual([{ method: "CASH", expected: 500 }]);
  });

  it("reconciliations are keyed by the outlet-local calendar date", async () => {
    const byDate = await saveDailyReconciliation(ctx, { outletId: india, businessDate: "2026-01-11", actuals: [{ method: "CASH", actual: 500 }] });
    expect(iso(byDate.businessDate)).toBe("2026-01-11T00:00:00.000Z");
    const byInstant = await saveDailyReconciliation(ctx, { outletId: india, businessDate: T, actuals: [{ method: "CASH", actual: 500 }] });
    expect(byInstant.id).toBe(byDate.id); // the instant maps to the same local day
    const closing = await dailyClosing(prisma, ctx, india, "2026-01-11");
    expect(closing).toMatchObject({ businessDate: "2026-01-11", reconciliationStatus: "DRAFT" });
    expect(closing.sales.grossSales).toBe(500);
  });

  it("date-only report filters are whole business days in the outlet's zone", async () => {
    const inIndia = await getReport(prisma, ctx, "PAYMENTS", { outletId: india, from: "2026-01-11", to: "2026-01-11" });
    expect(inIndia.rowCount).toBe(1);
    expect((await getReport(prisma, ctx, "PAYMENTS", { outletId: india, from: "2026-01-10", to: "2026-01-10" })).rowCount).toBe(0);
    expect((await getReport(prisma, ctx, "PAYMENTS", { outletId: ny, from: "2026-01-10", to: "2026-01-10" })).rowCount).toBe(1);
  });
});
