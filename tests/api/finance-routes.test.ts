/**
 * Phase 4 finance routes over HTTP (real handlers, sessions, services):
 * Idempotency-Key headers on expenses / petty cash / drawer movements, the
 * 2-decimal money rule (422), expense void behind step-up re-auth, B2B buyer
 * GSTIN + invoice issuance on orders, invoice / tax / aging / statement reads,
 * RBAC (403), tenant scope (404) and origin checks.
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
import * as Finance from "@/app/api/finance/[[...path]]/route";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Payments from "@/app/api/payments/[[...path]]/route";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";

const RUN = Date.now().toString(36);
const PW = "Finance#Pass123";
let orgId: string, outletA: string, dish: string;
let manager: string, cashier: string, kitchen: string, foreign: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; key?: string; origin?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  if (opts.origin) headers.origin = opts.origin;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 6)}@fin.test`, name: role, passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}
async function reauth(token: string, scope: string) {
  const req = new NextRequest("http://localhost/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PW, scope }), headers: { host: "localhost", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.7`, cookie: `${SESSION_COOKIE}=${token}` } });
  return (await reauthRoute(req)).status;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Fin API ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `FX${RUN}`, name: "A", gstin: "36ABCDE1234F1Z1" } })).id;
  dish = (await createMenuItem(systemContext(orgId, [outletA]), { name: `Idli ${RUN}`, price: 60, taxPct: 5 })).id;
  manager = await session(orgId, "MANAGER", outletA);
  cashier = await session(orgId, "CASHIER", outletA);
  kitchen = await session(orgId, "KITCHEN", outletA);
  foreign = await session((await prisma.organization.create({ data: { name: `Fin API 2 ${RUN}` } })).id, "OWNER", null);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("finance routes", () => {
  it("expense create replays on the Idempotency-Key header; money with 3 decimals is a 422; void needs re-auth", async () => {
    const body = { outletId: outletA, category: "UTILITIES", amount: 2450.75, description: "Power bill" };
    expect((await call(Finance, "POST", "expenses", { token: kitchen, body })).status).toBe(403);
    expect((await call(Finance, "POST", "expenses", { token: manager, body, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(Finance, "POST", "expenses", { token: manager, body: { ...body, amount: 10.125 } })).status).toBe(422);
    const a = await call(Finance, "POST", "expenses", { token: manager, body, key: `exp-${RUN}-1` });
    const b = await call(Finance, "POST", "expenses", { token: manager, body, key: `exp-${RUN}-1` });
    expect(a.status).toBe(200);
    expect(b.json.data).toMatchObject({ id: a.json.data.id, replayed: true });
    expect((await call(Finance, "POST", "expenses", { token: manager, body: { ...body, amount: 1 }, key: `exp-${RUN}-1` })).status).toBe(409);

    const voidPath = `expenses/${a.json.data.id}/void`;
    const denied = await call(Finance, "POST", voidPath, { token: manager, body: { reason: "Duplicate bill" } });
    expect([denied.status, denied.json.error.code]).toEqual([403, "ReauthRequiredError"]);
    expect(await reauth(manager, "finance.void")).toBe(200);
    expect((await call(Finance, "POST", voidPath, { token: manager, body: { reason: "Duplicate bill" } })).status).toBe(200);
    expect((await call(Finance, "GET", "expenses", { token: manager, query: { outletId: outletA } })).json.data.some((e: { id: string }) => e.id === a.json.data.id)).toBe(false);
    expect((await call(Finance, "GET", "expense-categories", { token: foreign })).status).toBe(200); // their own org's defaults only
  });

  it("petty cash and drawer movements replay on the header; pay-outs are bounded", async () => {
    expect((await call(Finance, "POST", "petty-cash", { token: manager, body: { outletId: outletA, type: "OPENING", amount: 1000 }, key: `pc-${RUN}-1` })).status).toBe(200);
    expect((await call(Finance, "POST", "petty-cash", { token: manager, body: { outletId: outletA, type: "OPENING", amount: 1000 }, key: `pc-${RUN}-1` })).json.data.replayed).toBe(true);
    const drawer = await call(Finance, "POST", "drawer/open", { token: cashier, body: { outletId: outletA, openingFloat: 500 } });
    const id = drawer.json.data.id;
    const mv = { type: "PAY_OUT", amount: 120, reason: "Ice delivery" };
    expect((await call(Finance, "POST", `drawer/${id}/movements`, { token: cashier, body: mv, key: `mv-${RUN}-1` })).status).toBe(200);
    expect((await call(Finance, "POST", `drawer/${id}/movements`, { token: cashier, body: mv, key: `mv-${RUN}-1` })).json.data.replayed).toBe(true);
    expect((await call(Finance, "POST", `drawer/${id}/movements`, { token: cashier, body: { ...mv, amount: 400 } })).status).toBe(422); // only 380 left
    expect((await call(Finance, "POST", `drawer/${id}/movements`, { token: kitchen, body: mv })).status).toBe(403);
    expect((await call(Finance, "POST", `drawer/${id}/movements`, { token: foreign, body: mv })).status).toBe(404);
    const closed = await call(Finance, "POST", `drawer/${id}/close`, { token: cashier, body: { closingCount: 380 } });
    expect(closed.json.data).toMatchObject({ expectedCash: 380, variance: 0 });
  });

  it("orders: B2B buyer GSTIN before payment, invoice on payment, invoice + tax reads", async () => {
    const o = await placeOrder(systemContext(orgId, [outletA]), { outletId: outletA, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dish, qty: 2 }] }); // 126
    expect((await call(Orders, "POST", `${o.id}/buyer`, { token: cashier, body: { gstin: "36ABCDE1234F1Z5" } })).status).toBe(422);
    expect((await call(Orders, "POST", `${o.id}/buyer`, { token: kitchen, body: { gstin: "27AAPFU0939F1ZV" } })).status).toBe(403);
    expect((await call(Orders, "POST", `${o.id}/buyer`, { token: cashier, body: { gstin: "27AAPFU0939F1ZV", name: "Acme" } })).status).toBe(200);
    const p = await call(Payments, "POST", "", { token: cashier, body: { orderId: o.id, method: "CASH", amount: 126 } });
    await call(Payments, "POST", `${p.json.data.id}/verify`, { token: cashier });
    const bill = await call(Orders, "GET", `${o.id}/bill`, { token: cashier });
    expect(bill.json.data.invoice).toMatchObject({ buyerGstin: "27AAPFU0939F1ZV", sellerGstin: "36ABCDE1234F1Z1", supplyType: "INTRA" });
    expect((await call(Orders, "POST", `${o.id}/invoice`, { token: cashier })).json.data.number).toBe(bill.json.data.invoice.number); // idempotent
    const invoices = await call(Finance, "GET", "invoices", { token: manager, query: { outletId: outletA } });
    expect(invoices.json.data.map((i: { number: string }) => i.number)).toContain(bill.json.data.invoice.number);
    expect((await call(Finance, "GET", "invoices", { token: cashier, query: { outletId: outletA } })).status).toBe(200); // cashier holds finance.view
    expect((await call(Finance, "GET", "invoices", { token: kitchen, query: { outletId: outletA } })).status).toBe(403);
    expect((await call(Finance, "GET", "invoices", { token: foreign, query: { outletId: outletA } })).status).toBe(404); // another tenant's outlet
    const tax = await call(Finance, "GET", "tax-summary", { token: manager, query: { outletId: outletA } });
    expect(tax.json.data).toEqual([expect.objectContaining({ kind: "INVOICE", ratePct: 5, taxableValue: 120, cgst: 3, sgst: 3, totalTax: 6 })]);
  });

  it("vendor aging, statement and reversal (re-auth) are reachable with the right permissions only", async () => {
    expect((await call(Finance, "GET", "vendor-aging", { token: manager, query: { outletId: outletA } })).status).toBe(200);
    expect((await call(Finance, "GET", "vendor-aging", { token: kitchen, query: { outletId: outletA } })).status).toBe(403);
    expect((await call(Finance, "GET", "vendor-statement", { token: manager, query: { vendorId: "nope" } })).status).toBe(404);
    // A session without a fresh finance.void grant is stopped by the gate before anything else.
    const denied = await call(Finance, "POST", "vendor-payments/nope/reverse", { token: cashier, body: { reason: "bounced" } });
    expect(denied.json.error.code).toBe("ReauthRequiredError");
  });
});
