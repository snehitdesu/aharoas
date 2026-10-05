/**
 * Phase 9: concurrent settlements at ONE outlet.
 *
 * Every settlement increments the outlet's gap-free invoice counter (one row),
 * so under PostgreSQL SERIALIZABLE overlapping settlements used to abort each
 * other (measured: 70% of a 20-way burst exhausted the retries -> HTTP 503).
 * They now queue per outlet in-process (keyedLock.ts) before opening their
 * transaction; isolation is unchanged. Invariants checked: every payment
 * settles exactly once, invoice numbers are unique and gap-free, nothing is
 * charged twice.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { withKeyedLock, heldKeyCount } from "@/server/services/keyedLock";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, itemId: string;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Settle Conc ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `SC${RUN}`, name: "SC" } })).id;
  itemId = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `SC item ${RUN}`, price: 100, taxPct: 5 } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("keyed lock", () => {
  it("runs one key's holders one at a time in arrival order, other keys in parallel, and releases on error", async () => {
    const events: string[] = [];
    const hold = (key: string, name: string, ms: number, fail = false) =>
      withKeyedLock(key, async () => {
        events.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`end ${name}`);
        if (fail) throw new Error("boom");
        return name;
      });
    const res = await Promise.allSettled([hold("a", "a1", 30, true), hold("a", "a2", 10), hold("b", "b1", 5)]);
    expect(res.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    // a2 starts only after a1 ended (despite a1 throwing); b1 did not wait for a1.
    expect(events.indexOf("start a2")).toBeGreaterThan(events.indexOf("end a1"));
    expect(events.indexOf("end b1")).toBeLessThan(events.indexOf("end a1"));
    expect(heldKeyCount()).toBe(0);
  });
});

describe("concurrent settlements at one outlet", () => {
  const ctx = () => systemContext(orgId, [outletId]);

  it("a 12-way burst: every payment settles once, invoice numbers unique and gap-free", async () => {
    const orders = [];
    for (let i = 0; i < 12; i++) orders.push(await placeOrder(ctx(), { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: itemId, qty: 1 + (i % 3) }] }));
    const payments = [];
    for (const o of orders) payments.push(await createPayment(ctx(), o.id, { method: "CASH", amount: Number(o.total) }));

    const res = await Promise.allSettled(payments.map((p) => verifyPayment(ctx(), p.id)));
    const rejected = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.map((r) => String((r.reason as Error)?.message))).toEqual([]);
    expect(res.every((r) => r.status === "fulfilled" && r.value.orderSettled)).toBe(true);

    const settled = await prisma.order.findMany({ where: { id: { in: orders.map((o) => o.id) } }, select: { status: true, invoiceNo: true } });
    expect(settled.every((o) => o.status === "PAID" && o.invoiceNo)).toBe(true);
    const invoices = await prisma.taxInvoice.findMany({ where: { outletId, kind: "INVOICE" }, select: { seq: true, orderId: true } });
    expect(invoices).toHaveLength(12);
    expect(new Set(invoices.map((i) => i.orderId)).size).toBe(12);
    expect(invoices.map((i) => i.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    // Re-verifying is a no-op (no second invoice, no double charge).
    await Promise.all(payments.slice(0, 4).map((p) => verifyPayment(ctx(), p.id)));
    expect(await prisma.taxInvoice.count({ where: { outletId, kind: "INVOICE" } })).toBe(12);
    expect(await prisma.payment.count({ where: { outletId, status: "SUCCESS" } })).toBe(12);
  });
});
