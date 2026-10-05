/**
 * Phase 3 routes over HTTP (real handlers, sessions, services): opening stock,
 * manual adjustments, the unmapped-sale queue, and Idempotency-Key headers on
 * GRN / bill / wastage creation. Auth, RBAC (403), origin checks, validation
 * (422), conflicts (409) and tenant scope (404).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import * as Inventory from "@/app/api/inventory/[[...path]]/route";
import * as Procurement from "@/app/api/procurement/[[...path]]/route";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, kg: string, g: string, rice: string, vendor: string;
let manager: string, store: string, kitchen: string, foreign: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; key?: string; origin?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  if (opts.origin) headers.origin = opts.origin;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path.split("/") }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 6)}@inv.test`, name: role, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Inv API ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `IA${RUN}`, name: "A" } })).id;
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  g = (await prisma.unit.create({ data: { organizationId: orgId, code: `g${RUN}`, name: "g", kind: "WEIGHT" } })).id;
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: g, toUnitId: kg, factor: 0.001 } });
  rice = (await prisma.material.create({ data: { organizationId: orgId, sku: `R-${RUN}`, name: "Rice", baseUnitId: kg } })).id;
  vendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `V ${RUN}` } })).id;
  manager = await session(orgId, "MANAGER", outletA);
  store = await session(orgId, "STORE", outletA);
  kitchen = await session(orgId, "KITCHEN", outletA);
  const org2 = (await prisma.organization.create({ data: { name: `Inv API 2 ${RUN}` } })).id;
  foreign = await session(org2, "OWNER", null);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("inventory routes", () => {
  it("opening stock: RBAC, base units, replay", async () => {
    const body = { outletId: outletA, lines: [{ materialId: rice, qty: 20000, rate: 0.05, unitId: g }] };
    expect((await call(Inventory, "POST", "opening-stock", { body })).status).toBe(401);
    expect((await call(Inventory, "POST", "opening-stock", { token: kitchen, body })).status).toBe(403);
    expect((await call(Inventory, "POST", "opening-stock", { token: store, body, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(Inventory, "POST", "opening-stock", { token: store, body: { ...body, lines: [{ ...body.lines[0], unitPrice: 1 }] } })).status).toBe(422);
    const ok = await call(Inventory, "POST", "opening-stock", { token: store, body });
    expect(ok.status).toBe(200);
    expect((await call(Inventory, "POST", "opening-stock", { token: store, body })).json.data.lines[0].replayed).toBe(true);
    const stock = await call(Inventory, "GET", "stock", { token: store, query: { outletId: outletA } });
    expect(stock.json.data.find((r: { materialId: string }) => r.materialId === rice)).toMatchObject({ quantity: 20, avgCost: 50 });
  });

  it("adjustments need an Idempotency-Key; a retry replays; a different body under the key is 409", async () => {
    const body = { outletId: outletA, materialId: rice, qty: -2, reason: "DATA_ENTRY_ERROR", note: "double-entered delivery" };
    expect((await call(Inventory, "POST", "adjustments", { token: store, body })).status).toBe(422);
    const k = `adj-${RUN}-1`;
    const a = await call(Inventory, "POST", "adjustments", { token: store, body, key: k });
    expect(a.status).toBe(200);
    const b = await call(Inventory, "POST", "adjustments", { token: store, body, key: k });
    expect(b.json.data).toMatchObject({ replayed: true, row: { id: a.json.data.row.id } });
    expect((await call(Inventory, "POST", "adjustments", { token: store, body: { ...body, qty: -3 }, key: k })).status).toBe(409);
    expect((await call(Inventory, "POST", "adjustments", { token: store, body: { ...body, qty: -1000 }, key: `adj-${RUN}-2` })).status).toBe(422); // shortage
    expect((await call(Inventory, "POST", "adjustments", { token: foreign, body, key: `adj-${RUN}-3` })).status).toBe(404); // foreign outlet: not in their org
  });

  it("unmapped queue: list needs inventory.view; resolve needs recipe.manage", async () => {
    const sale = await prisma.unmappedSale.create({ data: { organizationId: orgId, outletId: outletA, posCode: `X-${RUN}`, posName: "Mystery", qty: 1, source: "PETPOOJA" } });
    const list = await call(Inventory, "GET", "unmapped", { token: store, query: { outletId: outletA } });
    expect(list.json.data.map((s: { id: string }) => s.id)).toContain(sale.id);
    expect((await call(Inventory, "POST", `unmapped/${sale.id}/resolve`, { token: store, body: { action: "IGNORE", note: "fee line" } })).status).toBe(403);
    expect((await call(Inventory, "POST", `unmapped/${sale.id}/resolve`, { token: foreign, body: { action: "IGNORE", note: "fee line" } })).status).toBe(404);
    expect((await call(Inventory, "POST", `unmapped/${sale.id}/resolve`, { token: manager, body: { action: "IGNORE", note: "fee line" } })).json.data.sale.status).toBe("IGNORED");
  });
});

describe("procurement routes", () => {
  it("GRN, bill and wastage creation replay on the same Idempotency-Key header", async () => {
    const grnBody = { outletId: outletA, vendorId: vendor, lines: [{ materialId: rice, qty: 5, rate: 40 }] };
    const g1 = await call(Procurement, "POST", "grns", { token: store, body: grnBody, key: `grn-${RUN}-1` });
    const g2 = await call(Procurement, "POST", "grns", { token: store, body: grnBody, key: `grn-${RUN}-1` });
    expect(g2.json.data).toMatchObject({ id: g1.json.data.id, replayed: true });
    expect((await call(Procurement, "POST", "grns", { token: store, body: { ...grnBody, lines: [{ materialId: rice, qty: 6, rate: 40 }] }, key: `grn-${RUN}-1` })).status).toBe(409);
    expect((await call(Procurement, "POST", `grns/${g1.json.data.id}/post`, { token: store })).status).toBe(200);

    const billBody = { outletId: outletA, vendorId: vendor, grnId: g1.json.data.id, vendorInvoiceNo: `VI-${RUN}`, lines: [{ materialId: rice, qty: 5, rate: 40 }] };
    expect((await call(Procurement, "POST", "bills", { token: store, body: billBody, key: `bill-${RUN}-1` })).status).toBe(403); // STORE cannot manage bills
    const b1 = await call(Procurement, "POST", "bills", { token: manager, body: billBody, key: `bill-${RUN}-1` });
    expect((await call(Procurement, "POST", "bills", { token: manager, body: billBody, key: `bill-${RUN}-1` })).json.data.id).toBe(b1.json.data.id);
    const dup = await call(Procurement, "POST", "bills", { token: manager, body: { ...billBody, grnId: undefined }, key: `bill-${RUN}-2` });
    expect(dup.status).toBe(409); // same vendor invoice
    expect(dup.json.error.message).toMatch(/already recorded/);

    const wBody = { outletId: outletA, reason: "SPILLAGE", lines: [{ materialId: rice, qty: 1 }] };
    const w1 = await call(Inventory, "POST", "wastage", { token: store, body: wBody, key: `w-${RUN}-1` });
    expect((await call(Inventory, "POST", "wastage", { token: store, body: wBody, key: `w-${RUN}-1` })).json.data.id).toBe(w1.json.data.id);
  });

  it("manual PO moves to receiving/billing states are refused over HTTP", async () => {
    const po = await call(Procurement, "POST", "purchase-orders", { token: manager, body: { outletId: outletA, vendorId: vendor, lines: [{ materialId: rice, qty: 1, rate: 40 }] } });
    for (const to of ["SUBMITTED", "APPROVED"]) expect((await call(Procurement, "POST", `purchase-orders/${po.json.data.id}/transition`, { token: manager, body: { to } })).status).toBe(200);
    const bad = await call(Procurement, "POST", `purchase-orders/${po.json.data.id}/transition`, { token: manager, body: { to: "RECEIVED" } });
    expect(bad.status).toBe(422);
    expect(bad.json.error.message).toMatch(/by receiving or billing/);
  });
});
