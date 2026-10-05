/**
 * Phase 9 load-test regression: concurrent POS placements that send to the
 * kitchen at ONE outlet.
 *
 * KOT numbers used to be `max(number) + 1` read inside the SERIALIZABLE order
 * transaction. Every placement then read and wrote the same index range, so on
 * PostgreSQL concurrent placements formed read/write dependency cycles and all
 * but a few were aborted (P2034) — measured: 15 of 20 concurrent placements
 * failed with HTTP 500 even after 5 retries. PostgreSQL now draws the number
 * from a sequence (no predicate read, no extra connection); SQLite serializes
 * writers anyway and keeps max + 1. Remaining conflicts are SSI page-granularity
 * false positives on hot index pages: retried with exponential backoff; one that
 * outlives the retries is a 503 (safe to repeat — creates are idempotency-keyed).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { placeOrder, addOrderRound } from "@/server/services/orders";

const onPostgres = /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, items: string[];

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `KOT Conc ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `KC${RUN}`, name: "KC" } })).id;
  items = [];
  for (const [i, station] of ["KITCHEN", "BAR", "KITCHEN"].entries()) {
    items.push((await prisma.menuItem.create({ data: { organizationId: orgId, name: `KC item ${i} ${RUN}`, price: 50 + i, taxPct: 0, station } })).id);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("concurrent kitchen orders at one outlet", () => {
  const ctx = () => systemContext(orgId, [outletId]);
  const place = (i: number) => placeOrder(ctx(), { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: items[i % 3], qty: 1 }, { menuItemId: items[(i + 1) % 3], qty: 2 }] });

  it("under a 20-way stress burst, anything that fails is a retryable conflict (HTTP 503) — never a wrong number, a partial order or another error", async () => {
    const before = await prisma.order.count({ where: { outletId } });
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => place(i)));
    const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const f of failed) expect((f.reason as { code?: string })?.code).toBe("P2034");
    if (failed.length) {
      const { fail } = await import("@/server/api/respond");
      const r = fail(failed[0].reason);
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("1");
    }
    // Failed placements left nothing behind (atomic); successful ones are complete with their KOTs.
    const orders = await prisma.order.findMany({ where: { outletId }, include: { kots: true } });
    expect(orders.length - before).toBe(20 - failed.length);
    expect(orders.every((o) => o.kots.length > 0 && o.status === "SENT")).toBe(true);
    const numbers = orders.flatMap((o) => o.kots.map((k) => k.number));
    expect(new Set(numbers).size).toBe(numbers.length);
    // Before the fix, the shared max(number) read made every pair conflict: 12–15 of 20 failed.
    // Now only SSI page-granularity false positives remain (worst on near-empty tables like this
    // test database's): most of the burst commits. Capacity on a populated database is measured
    // by scripts/ops/load-test.mjs (docs/production-infrastructure.md §Load test).
    expect(20 - failed.length).toBeGreaterThan(10);
    // PostgreSQL: new-order placement runs at READ COMMITTED (it shares no rows with other
    // placements; orders.ts NEW_ORDER_TX), so SSI false positives cannot abort it any more.
    if (onPostgres) expect(failed.length).toBe(0);
  });

  it("the same Idempotency-Key raced 10 ways still creates exactly ONE order (unique index, any isolation level)", async () => {
    const key = `race-${RUN}-0001`;
    const body = { outletId, channel: "TAKEAWAY" as const, submit: true, idempotencyKey: key, items: [{ menuItemId: items[0], qty: 1 }] };
    const res = await Promise.allSettled(Array.from({ length: 10 }, () => placeOrder(ctx(), body)));
    const ok = res.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof placeOrder>>>).value);
    for (const r of res) if (r.status === "rejected") expect((r.reason as { code?: string })?.code).toBe("P2034");
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((o) => o.id)).size).toBe(1);
    const rows = await prisma.order.findMany({ where: { organizationId: orgId, idempotencyKey: key }, include: { items: true, kots: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].items).toHaveLength(1);
    expect(rows[0].kots).toHaveLength(1);
  });

  it("concurrent rounds on ONE existing order (still SERIALIZABLE) never lose a line or a total", async () => {
    const order = await place(100);
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => addOrderRound(ctx(), order.id, { items: [{ menuItemId: items[i % 3], qty: 1 }], fire: true })));
    const okCount = res.filter((r) => r.status === "fulfilled").length;
    for (const r of res) if (r.status === "rejected") expect((r.reason as { code?: string })?.code).toBe("P2034");
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: { include: { kotItems: true } } } });
    expect(after.items).toHaveLength(2 + okCount);
    expect(after.items.every((i) => i.kotItems.length === 1)).toBe(true);
    const sum = after.items.reduce((a, i) => a + Number(i.lineTotal), 0);
    expect(Number(after.subtotal)).toBeCloseTo(sum, 2);
  });
});
