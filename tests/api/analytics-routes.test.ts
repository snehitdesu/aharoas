/**
 * Phase 5 analytics routes over HTTP (real handlers, sessions, services):
 * date-only filters resolve to the outlet's business days (inclusive end),
 * invalid / reversed / over-long ranges are 422, unknown metrics 404, RBAC 403
 * per metric (finance needs finance.view; sales needs reports.view), another
 * tenant's outlet is refused, and insights require an outlet and filter rules
 * by the caller's permissions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { systemContext } from "@/server/auth/context";
import { SESSION_COOKIE } from "@/constants/auth";
import { createMenuItem } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import * as Analytics from "@/app/api/analytics/[[...path]]/route";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string;
let manager: string, cashier: string, kitchen: string, foreign: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function get(path: string, token: string, query: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/analytics/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = new NextRequest(url, { method: "GET", headers: { host: "localhost", cookie: `${SESSION_COOKIE}=${token}` } });
  const res = await (Analytics as unknown as Mod).GET(req, { params: Promise.resolve({ path: path.split("/") }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 6)}@p5.test`, name: role, passwordHash: await hashPassword("Analytics#Pass123") } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `P5 API ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P5X${RUN}`, name: "A", timezone: "Asia/Kolkata" } })).id;
  const sys = systemContext(orgId, [outletA]);
  const dish = (await createMenuItem(sys, { name: `Vada ${RUN}`, price: 60, taxPct: 0 })).id;
  // One paid order at 2026-04-01 00:15 IST (= 2026-03-31 18:45Z).
  const o = await placeOrder(sys, { outletId: outletA, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dish, qty: 2 }] });
  const p = await createPayment(sys, o.id, { method: "CASH", amount: 120 });
  await verifyPayment(sys, p.id);
  await prisma.order.update({ where: { id: o.id }, data: { createdAt: new Date("2026-03-31T18:45:00Z") } });
  await prisma.payment.update({ where: { id: p.id }, data: { createdAt: new Date("2026-03-31T18:45:00Z") } });
  manager = await session(orgId, "MANAGER", outletA);
  cashier = await session(orgId, "CASHIER", outletA);
  kitchen = await session(orgId, "KITCHEN", outletA);
  foreign = await session((await prisma.organization.create({ data: { name: `P5 API 2 ${RUN}` } })).id, "OWNER", null);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("analytics routes", () => {
  it("date-only filters are outlet business days with an inclusive end", async () => {
    const apr1 = await get("sales-summary", manager, { outletId: outletA, from: "2026-04-01", to: "2026-04-01" });
    expect(apr1.status).toBe(200);
    expect(apr1.json.data).toMatchObject({ orders: 1, grossSales: 120 });
    const mar31 = await get("sales-summary", manager, { outletId: outletA, from: "2026-03-31", to: "2026-03-31" });
    expect(mar31.json.data.orders).toBe(0); // 18:45Z on Mar 31 is already Apr 1 in IST
    const trend = await get("sales-trend", manager, { outletId: outletA, from: "2026-03-01", to: "2026-04-30", granularity: "month" });
    expect(trend.json.data).toEqual([expect.objectContaining({ period: "2026-04", orders: 1, netSales: 120 })]);
  });

  it("validates filters: reversed range, malformed date, over-long range, unknown metric", async () => {
    expect((await get("sales-summary", manager, { outletId: outletA, from: "2026-04-02", to: "2026-04-01" })).status).toBe(422);
    expect((await get("sales-summary", manager, { outletId: outletA, from: "2026-13-45" })).status).toBe(422);
    expect((await get("daily-sales", manager, { outletId: outletA, from: "2024-01-01", to: "2026-04-01" })).status).toBe(422);
    expect((await get("granularity-x", manager, { outletId: outletA })).status).toBe(404);
    expect((await get("sales-trend", manager, { outletId: outletA, granularity: "year" })).status).toBe(422);
  });

  it("RBAC per metric and tenant scope", async () => {
    expect((await get("items", cashier, { outletId: outletA })).status).toBe(403);
    expect((await get("finance", kitchen, { outletId: outletA })).status).toBe(403); // no finance.view (a cashier has it, by design)
    expect((await get("finance", manager, { outletId: outletA })).json.data.pnl).toMatchObject({ estimate: true });
    expect((await get("payments", manager, { outletId: outletA, from: "2026-04-01", to: "2026-04-01" })).json.data).toEqual([{ method: "CASH", count: 1, collected: 120, refunded: 0, net: 120, amount: 120 }]);
    expect([403, 404]).toContain((await get("sales-summary", foreign, { outletId: outletA })).status);
  });

  it("insights need an outlet and only include rules the caller may see", async () => {
    expect((await get("insights", manager)).status).toBe(422);
    const m = await get("insights", manager, { outletId: outletA });
    expect(m.status).toBe(200);
    expect(m.json.data).toMatchObject({ outletId: outletA, rules: expect.objectContaining({ salesDropPct: 30 }) });
    const k = await get("insights", kitchen, { outletId: outletA });
    expect(k.status).toBe(200);
    expect(k.json.data.insights.every((i: { category: string }) => i.category === "inventory")).toBe(true);
    expect([403, 404]).toContain((await get("insights", foreign, { outletId: outletA })).status);
  });
});
