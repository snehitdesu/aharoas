/**
 * Guest QR API (/api/qr/*) and the staff bill route over HTTP: real route
 * handlers, real services. Covers the anonymous surface: no session needed,
 * origin checks, body caps, order access only via the x-order-key header,
 * never-cached responses, per-table order limits, and error mapping.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { systemContext } from "@/server/auth/context";
import { SESSION_COOKIE } from "@/constants/auth";
import { rotateTableQr } from "@/server/services/masterData";
import { createMenuItem } from "@/server/services/menu";
import { getRateLimitStore, RATE_POLICIES } from "@/server/api/rateLimit";
import * as Guest from "@/app/api/qr/[[...path]]/route";
import * as Orders from "@/app/api/orders/[[...path]]/route";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, token: string, dish: string, cashier: string, foreign: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { cookie?: string; body?: unknown; rawBody?: string; origin?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost", "x-forwarded-for": `198.51.100.${RUN.length}`, ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  if (opts.origin) headers.origin = opts.origin;
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const req = new NextRequest(new URL(`http://localhost/api/x/${path}`), { method, headers, body });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 7)}@guest.test`, name: role, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Guest API ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `GA${RUN}`, name: "Guest Outlet" } })).id;
  const ctx = systemContext(orgId, [outletId]);
  const table = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: "T9" } });
  token = (await rotateTableQr(ctx, table.id)).qrToken!;
  dish = (await createMenuItem(ctx, { name: `Dosa ${RUN}`, price: 100, taxPct: 5 })).id;
  cashier = await session(orgId, "CASHIER", outletId);
  const org2 = (await prisma.organization.create({ data: { name: `Guest API other ${RUN}` } })).id;
  foreign = await session(org2, "OWNER", null);
});

afterAll(async () => { await prisma.$disconnect(); });

const ORIGIN = "http://localhost";

describe("guest API", () => {
  it("quotes a cart over HTTP (read-only, same-origin, its own per-IP limit) without creating an order", async () => {
    const before = await prisma.order.count({ where: { organizationId: orgId } });
    const q = await call(Guest, "POST", `t/${token}/quote`, { origin: ORIGIN, body: { items: [{ menuItemId: dish, qty: 2 }] } });
    expect(q.status).toBe(200);
    expect(q.headers.get("cache-control")).toBe("no-store");
    expect(q.json.data).toMatchObject({ subtotal: "200.00", tax: "10.00", total: "210.00", allAvailable: true });
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(before);
    expect((await call(Guest, "POST", `t/${token}/quote`, { origin: "https://evil.example", body: { items: [{ menuItemId: dish, qty: 1 }] } })).status).toBe(403);
    expect((await call(Guest, "POST", `t/${token}/quote`, { origin: ORIGIN, body: { items: [{ menuItemId: dish, qty: 1, unitPrice: 1 }] } })).status).toBe(422);
    expect((await call(Guest, "POST", "t/unknown-token-xyz/quote", { origin: ORIGIN, body: { items: [{ menuItemId: dish, qty: 1 }] } })).status).toBe(404);
    expect(RATE_POLICIES.guestQuotePerIp.limit).toBeGreaterThan(RATE_POLICIES.guestWritePerIp.limit);
  });

  it("serves the menu without a session, never cached; bad tokens are a uniform 404", async () => {
    const menu = await call(Guest, "GET", `t/${token}`);
    expect(menu.status).toBe(200);
    expect(menu.headers.get("cache-control")).toBe("no-store");
    expect(menu.json.data.menu.map((i: { name: string }) => i.name)).toContain(`Dosa ${RUN}`);
    for (const bad of ["nope-nope-nope", "%2e%2e%2fadmin"]) {
      const r = await call(Guest, "GET", `t/${bad}`);
      expect(r.status).toBe(404);
      expect(r.json.error.message).toMatch(/not valid/);
    }
    expect((await call(Guest, "GET", "admin/users")).status).toBe(404);
  });

  it("places an order (Idempotency-Key header), rejects cross-origin writes, oversized and tampered bodies", async () => {
    const body = { items: [{ menuItemId: dish, qty: 2 }] };
    expect((await call(Guest, "POST", `t/${token}/orders`, { body, origin: "https://evil.example", headers: { "idempotency-key": `ga-${RUN}-1` } })).status).toBe(403);
    expect((await call(Guest, "POST", `t/${token}/orders`, { body, origin: ORIGIN })).status).toBe(422); // key required
    expect((await call(Guest, "POST", `t/${token}/orders`, { rawBody: "x".repeat(40_000), origin: ORIGIN, headers: { "idempotency-key": `ga-${RUN}-2` } })).status).toBe(413);
    const tampered = await call(Guest, "POST", `t/${token}/orders`, { body: { items: [{ menuItemId: dish, qty: 2, unitPrice: 0.01 }] }, origin: ORIGIN, headers: { "idempotency-key": `ga-${RUN}-3` } });
    expect(tampered.status).toBe(422);

    const placed = await call(Guest, "POST", `t/${token}/orders`, { body, origin: ORIGIN, headers: { "idempotency-key": `ga-${RUN}-4` } });
    expect(placed.status).toBe(200);
    expect(placed.headers.get("set-cookie")).toBeNull();
    const { orderId, accessKey } = placed.json.data;
    const replay = await call(Guest, "POST", `t/${token}/orders`, { body, origin: ORIGIN, headers: { "idempotency-key": `ga-${RUN}-4` } });
    expect(replay.json.data).toMatchObject({ orderId, replayed: true });

    expect((await call(Guest, "GET", `orders/${orderId}`)).status).toBe(404);
    expect((await call(Guest, "GET", `orders/${orderId}`, { headers: { "x-order-key": "forged" } })).status).toBe(404);
    const view = await call(Guest, "GET", `orders/${orderId}`, { headers: { "x-order-key": accessKey } });
    expect(view.status).toBe(200);
    expect(view.json.data).toMatchObject({ status: "OPEN", fulfilment: "AWAITING_ACCEPTANCE", bill: { total: "210.00", table: "T9" } });

    // Pay: start (server amount) -> confirm via the gateway.
    const start = await call(Guest, "POST", `orders/${orderId}/payments`, { origin: ORIGIN, headers: { "x-order-key": accessKey, "idempotency-key": `gp-${RUN}-1` } });
    expect(start.json.data).toMatchObject({ amount: "210.00" });
    const forged = await call(Guest, "POST", `orders/${orderId}/payments/confirm`, { body: { paymentId: start.json.data.paymentId, status: "SUCCESS" }, origin: ORIGIN, headers: { "x-order-key": accessKey } });
    expect(forged.status).toBe(422);
    const confirmed = await call(Guest, "POST", `orders/${orderId}/payments/confirm`, { body: { paymentId: start.json.data.paymentId }, origin: ORIGIN, headers: { "x-order-key": accessKey } });
    expect(confirmed.json.data).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID", bill: { kind: "RECEIPT", paymentStatus: "PAID" } });

    // Staff bill route: session required, scoped to the tenant.
    expect((await call(Orders, "GET", `${orderId}/bill`)).status).toBe(401);
    expect((await call(Orders, "GET", `${orderId}/bill`, { cookie: foreign })).status).toBe(404);
    const bill = await call(Orders, "GET", `${orderId}/bill`, { cookie: cashier });
    expect(bill.status).toBe(200);
    expect(bill.json.data).toEqual(confirmed.json.data.bill);
  });

  it("limits orders per table", async () => {
    const store = getRateLimitStore();
    const k = `${RATE_POLICIES.guestOrderPerTable.name}:${token}`;
    for (let i = 0; i < RATE_POLICIES.guestOrderPerTable.limit; i++) await store.hit(k, RATE_POLICIES.guestOrderPerTable.windowMs);
    const r = await call(Guest, "POST", `t/${token}/orders`, { body: { items: [{ menuItemId: dish, qty: 1 }] }, origin: ORIGIN, headers: { "idempotency-key": `ga-${RUN}-9` } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    await store.reset(k);
  });
});
