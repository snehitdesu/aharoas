/**
 * API route tests: real route handlers, real sessions (session service), real
 * services. Verifies authentication, validation -> 4xx mapping, RBAC, outlet +
 * organization scope, pagination, CSV export and a full order flow over HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Payments from "@/app/api/payments/[[...path]]/route";
import * as Kitchen from "@/app/api/kitchen/[[...path]]/route";
import * as Reports from "@/app/api/reports/[[...path]]/route";
import * as Exports from "@/app/api/exports/[[...path]]/route";
import * as Analytics from "@/app/api/analytics/[[...path]]/route";
import * as Customers from "@/app/api/customers/[[...path]]/route";
import * as Notifications from "@/app/api/notifications/[[...path]]/route";
import * as Anomalies from "@/app/api/anomalies/[[...path]]/route";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string;
let mgrA: string, mgrB: string, cashierA: string, kitchenA: string, foreign: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string; origin?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  if (opts.origin) headers.origin = opts.origin;
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const req = new NextRequest(url, { method, headers, body });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function userWithSession(org: string, tag: string, role: string, outletId: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${tag}-${RUN}@api.test`, name: tag, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `API Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AB${RUN}`, name: "B" } })).id;
  mgrA = await userWithSession(orgId, "mgra", "MANAGER", outletA);
  mgrB = await userWithSession(orgId, "mgrb", "MANAGER", outletB);
  cashierA = await userWithSession(orgId, "casha", "CASHIER", outletA);
  kitchenA = await userWithSession(orgId, "kita", "KITCHEN", outletA);
  const org2 = (await prisma.organization.create({ data: { name: `API Org2 ${RUN}` } })).id;
  foreign = await userWithSession(org2, "owner2", "OWNER", null);
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId: outletA, name: "KITCHEN" } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("authentication and request handling", () => {
  it("requires a valid session", async () => {
    expect((await call(Orders, "GET", "", { query: { outletId: outletA } })).status).toBe(401);
    expect((await call(Orders, "GET", "", { token: "forged", query: { outletId: outletA } })).status).toBe(401);
  });

  it("maps unknown endpoints, wrong methods, bad JSON, invalid input and cross-origin writes", async () => {
    expect((await call(Orders, "GET", "nope/deeper/path", { token: mgrA })).status).toBe(404);
    const wrong = await call(Orders, "PATCH", "", { token: mgrA, body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toContain("POST");
    expect((await call(Orders, "POST", "", { token: mgrA, rawBody: "{not json" })).status).toBe(422);
    const invalid = await call(Orders, "POST", "", { token: mgrA, body: { outletId: outletA, covers: -3 } });
    expect(invalid.status).toBe(422); // Zod error from the service is a 4xx, not a 500
    expect(invalid.json.error.code).toBe("ValidationError");
    expect((await call(Orders, "POST", "", { token: mgrA, body: { outletId: outletA }, origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("order flow over HTTP", () => {
  it("create -> add item -> submit (KOT) -> kitchen -> pay -> PAID", async () => {
    const created = await call(Orders, "POST", "", { token: mgrA, body: { outletId: outletA, channel: "TAKEAWAY" } });
    expect(created.status).toBe(200);
    const orderId = created.json.data.id;
    expect((await call(Orders, "POST", `${orderId}/items`, { token: mgrA, body: { name: "Idli", qty: 2, unitPrice: 60 } })).status).toBe(200);
    expect((await call(Orders, "POST", `${orderId}/submit`, { token: mgrA })).json.data.status).toBe("SENT");

    const board = await call(Kitchen, "GET", "kots", { token: kitchenA, query: { outletId: outletA } });
    const kot = board.json.data.find((k: any) => k.orderId === orderId);
    expect(kot.items).toHaveLength(1);
    for (const s of ["ACCEPTED", "PREPARING", "READY"]) expect((await call(Kitchen, "POST", `kots/${kot.id}/status`, { token: kitchenA, body: { status: s } })).status).toBe(200);
    expect((await call(Kitchen, "POST", `kots/${kot.id}/status`, { token: kitchenA, body: { status: "NEW" } })).status).toBe(422);
    const notes = await call(Notifications, "GET", "", { token: mgrA });
    expect(notes.json.data.some((n: any) => n.type === "ORDER_READY" && n.body === orderId)).toBe(true);

    const pay = await call(Payments, "POST", "", { token: cashierA, body: { orderId, method: "CASH", amount: 120 } });
    expect(pay.json.data.status).toBe("PENDING");
    expect((await call(Payments, "POST", `${pay.json.data.id}/verify`, { token: cashierA })).json.data.orderSettled).toBe(true);
    const order = await call(Orders, "GET", orderId, { token: mgrA });
    expect(order.json.data).toMatchObject({ status: "PAID" });
    expect(order.json.data.kots).toHaveLength(1);
    const page = await call(Orders, "GET", "", { token: mgrA, query: { outletId: outletA, take: "1" } });
    expect(page.json.data.items).toHaveLength(1);
  });

  it("enforces RBAC, outlet and organization scope", async () => {
    const created = await call(Orders, "POST", "", { token: mgrA, body: { outletId: outletA } });
    const orderId = created.json.data.id;
    expect((await call(Orders, "GET", "", { token: mgrB, query: { outletId: outletA } })).status).toBe(403);
    expect((await call(Orders, "GET", orderId, { token: mgrB })).status).toBe(403);
    expect((await call(Orders, "GET", orderId, { token: foreign })).status).toBe(404);
    expect((await call(Orders, "POST", `${orderId}/cancel`, { token: kitchenA, body: { reason: "nope" } })).status).toBe(403);
    expect((await call(Orders, "POST", "", { token: mgrB, body: { outletId: outletA } })).status).toBe(403);
  });
});

describe("reports, exports and analytics over HTTP", () => {
  it("lists only permitted reports and runs one", async () => {
    const mgrList = await call(Reports, "GET", "", { token: mgrA });
    expect(mgrList.json.data.map((r: any) => r.id)).toContain("PAYMENTS");
    const kitchenList = await call(Reports, "GET", "", { token: kitchenA });
    expect(kitchenList.json.data.map((r: any) => r.id)).not.toContain("PAYMENTS");
    const run = await call(Reports, "GET", "PAYMENTS", { token: mgrA, query: { outletId: outletA } });
    expect(run.status).toBe(200);
    expect(run.json.data.rowCount).toBeGreaterThanOrEqual(1);
    expect((await call(Reports, "GET", "PAYMENTS", { token: mgrB, query: { outletId: outletA } })).status).toBe(403);
    expect((await call(Reports, "GET", "PAYMENTS", { token: mgrA, query: { limit: "-1" } })).status).toBe(422);
  });

  it("exports CSV with job + audit; denies without export.run", async () => {
    const res = await call(Exports, "POST", "", { token: mgrA, body: { report: "PAYMENTS", filters: { outletId: outletA } } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="payments-/);
    expect(res.text.split("\r\n")[0]).toBe("Date,Outlet,Order,Method,Status,Amount,Provider,Provider ref,Verified");
    const jobId = res.headers.get("x-export-job-id")!;
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("SUCCESS");
    expect(await prisma.auditLog.count({ where: { entityType: "ExportJob", entityId: jobId, action: "EXPORT" } })).toBe(1);
    expect((await call(Exports, "POST", "", { token: cashierA, body: { report: "PAYMENTS", filters: { outletId: outletA } } })).status).toBe(403);
    expect((await call(Exports, "GET", "", { token: mgrA })).json.data.items.length).toBeGreaterThanOrEqual(1);
  });

  it("analytics metrics are permission-checked", async () => {
    const dash = await call(Analytics, "GET", "dashboard", { token: mgrA, query: { outletId: outletA } });
    expect(dash.status).toBe(200);
    expect(dash.json.data.orders).toBeGreaterThanOrEqual(1);
    expect((await call(Analytics, "GET", "dashboard", { token: cashierA, query: { outletId: outletA } })).status).toBe(403);
    expect((await call(Analytics, "GET", "made-up", { token: mgrA })).status).toBe(404);
  });
});

describe("other domains over HTTP", () => {
  it("customers: create, validation, org isolation", async () => {
    const c = await call(Customers, "POST", "", { token: cashierA, body: { name: "Ravi", phone: "9123400001" } });
    expect(c.status).toBe(200);
    expect((await call(Customers, "POST", "", { token: cashierA, body: { name: "", phone: "1" } })).status).toBe(422);
    expect((await call(Customers, "GET", c.json.data.id, { token: foreign })).json.data).toBeNull();
    expect((await call(Customers, "PATCH", c.json.data.id, { token: kitchenA, body: { name: "X" } })).status).toBe(403);
  });

  it("anomalies: scoped listing and transitions", async () => {
    expect((await call(Anomalies, "POST", "detect", { token: mgrA, body: { outletId: outletA } })).status).toBe(200);
    expect((await call(Anomalies, "GET", "", { token: mgrB, query: { outletId: outletA } })).status).toBe(403);
    expect((await call(Anomalies, "GET", "", { token: kitchenA })).status).toBe(403);
  });

  it("anomalies: take/cursor arrive as query strings and page correctly", async () => {
    const outlet = { organizationId: orgId, outletId: outletA, message: "paging" };
    await prisma.anomaly.createMany({ data: [1, 2, 3].map((i) => ({ ...outlet, type: "PRICE_SPIKE", severity: "LOW", entityId: `page-${RUN}-${i}` })) });
    const first = await call(Anomalies, "GET", "", { token: mgrA, query: { outletId: outletA, take: "2" } });
    expect(first.status).toBe(200);
    expect(first.json.data.items).toHaveLength(2);
    expect(first.json.data.nextCursor).toBeTruthy();
    const next = await call(Anomalies, "GET", "", { token: mgrA, query: { outletId: outletA, take: "2", cursor: first.json.data.nextCursor } });
    expect(next.status).toBe(200);
    expect(next.json.data.items.some((a: { id: string }) => first.json.data.items.some((b: { id: string }) => b.id === a.id))).toBe(false);
  });
});
