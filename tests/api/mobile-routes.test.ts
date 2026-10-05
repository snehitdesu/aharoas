/**
 * Phase 6 routes over HTTP (real handlers, sessions, services): captain rounds
 * with Idempotency-Key, line removal, bill request, the mobile read models,
 * per-user notification reads, staff administration behind password
 * re-confirmation, privilege escalation, inactive users, cross-outlet and
 * cross-organization access.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { systemContext } from "@/server/auth/context";
import { SESSION_COOKIE } from "@/constants/auth";
import { createMenuItem } from "@/server/services/menu";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Mobile from "@/app/api/mobile/[[...path]]/route";
import * as Staff from "@/app/api/staff/[[...path]]/route";
import * as Notifications from "@/app/api/notifications/[[...path]]/route";
import * as Kitchen from "@/app/api/kitchen/[[...path]]/route";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";

const RUN = Date.now().toString(36);
const PW = "Mobile#Pass123";
let orgId: string, A: string, B: string, tableA: string, dosa: string;
let captain: string, captainB: string, cashier: string, cashier2: string, kitchen: string, manager: string, foreign: string;
let captainId: string, managerId: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; key?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 7)}@p6api.test`, name: role, passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return { id: u.id, token: (await createSession(prisma, u.id)).token };
}
async function reauth(token: string, scope: string) {
  const req = new NextRequest("http://localhost/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PW, scope }), headers: { host: "localhost", "x-forwarded-for": `10.6.${Math.floor(Math.random() * 250)}.9`, cookie: `${SESSION_COOKIE}=${token}` } });
  return (await reauthRoute(req)).status;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `P6 API ${RUN}` } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P6X${RUN}`, name: "A" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P6Y${RUN}`, name: "B" } })).id;
  tableA = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: A, code: `M1-${RUN}` } })).id;
  dosa = (await createMenuItem(systemContext(orgId, [A, B]), { name: `Dosa ${RUN}`, price: 100, taxPct: 5 })).id;
  ({ id: captainId, token: captain } = await session(orgId, "CAPTAIN", A));
  ({ token: captainB } = await session(orgId, "CAPTAIN", B));
  ({ token: cashier } = await session(orgId, "CASHIER", A));
  ({ token: cashier2 } = await session(orgId, "CASHIER", A));
  ({ token: kitchen } = await session(orgId, "KITCHEN", A));
  ({ id: managerId, token: manager } = await session(orgId, "MANAGER", A));
  ({ token: foreign } = await session((await prisma.organization.create({ data: { name: `P6 API F ${RUN}` } })).id, "OWNER", null));
});

afterAll(async () => { await prisma.$disconnect(); });

describe("captain over HTTP", () => {
  it("open table -> keyed round (replayed on retry) -> remove unsent line -> request bill -> cashier alert", async () => {
    const placed = await call(Orders, "POST", "", { token: captain, key: `p6o-${RUN}`, body: { outletId: A, channel: "DINE_IN", tableId: tableA, items: [{ menuItemId: dosa, qty: 1 }], submit: true } });
    expect(placed.status, JSON.stringify(placed.json)).toBe(200);
    const id = placed.json.data.id as string;
    const round = { items: [{ menuItemId: dosa, qty: 2, notes: "crispy" }] };
    const r1 = await call(Orders, "POST", `${id}/rounds`, { token: captain, key: `p6r-${RUN}`, body: round });
    const r2 = await call(Orders, "POST", `${id}/rounds`, { token: captain, key: `p6r-${RUN}`, body: round });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r2.json.data.round).toMatchObject({ id: r1.json.data.round.id, replayed: true });
    expect(r2.json.data.order.items).toHaveLength(2);
    expect((await call(Orders, "POST", `${id}/rounds`, { token: captain, key: `p6r-${RUN}`, body: { items: [{ menuItemId: dosa, qty: 9 }] } })).status).toBe(409);
    expect((await call(Orders, "POST", `${id}/rounds`, { token: captain, key: `p6p-${RUN}`, body: { items: [{ menuItemId: dosa, qty: 1, unitPrice: 0.01 }] } })).status).toBe(422);

    const unsent = await call(Orders, "POST", `${id}/rounds`, { token: captain, key: `p6u-${RUN}`, body: { items: [{ menuItemId: dosa, qty: 1 }], fire: false } });
    const line = (unsent.json.data.order.items as Array<{ id: string; qty: string }>).find((i) => !r1.json.data.order.items.some((x: { id: string }) => x.id === i.id))!;
    expect((await call(Orders, "POST", `${id}/request-bill`, { token: captain, body: {} })).status).toBe(422); // an unsent line
    expect((await call(Orders, "DELETE", `items/${line.id}`, { token: kitchen })).status).toBe(403);
    expect((await call(Orders, "DELETE", `items/${line.id}`, { token: captain })).status).toBe(200);
    const bill = await call(Orders, "POST", `${id}/request-bill`, { token: captain, body: {} });
    expect(bill.status).toBe(200);
    expect(bill.json.data.status).toBe("BILLED");

    const alerts = await call(Notifications, "GET", "", { token: cashier });
    const alert = (alerts.json.data as Array<{ id: string; type: string; readAt: string | null }>).find((x) => x.type === "BILL_REQUESTED")!;
    expect(alert.readAt).toBeNull();
    expect((await call(Notifications, "POST", `${alert.id}/read`, { token: cashier, body: {} })).status).toBe(200);
    const mine = (await call(Notifications, "GET", "", { token: cashier })).json.data.find((x: { id: string }) => x.id === alert.id);
    const theirs = (await call(Notifications, "GET", "", { token: cashier2 })).json.data.find((x: { id: string }) => x.id === alert.id);
    expect([Boolean(mine.readAt), theirs.readAt]).toEqual([true, null]);
    expect((await call(Notifications, "GET", "", { token: kitchen })).json.data.some((x: { type: string }) => x.type === "BILL_REQUESTED")).toBe(false);
    expect((await call(Notifications, "POST", `${alert.id}/read`, { token: kitchen, body: {} })).status).toBe(403);
  });

  it("cross-outlet / cross-org / wrong role are refused", async () => {
    const placed = await call(Orders, "POST", "", { token: captain, key: `p6x-${RUN}`, body: { outletId: A, channel: "TAKEAWAY", items: [{ menuItemId: dosa, qty: 1 }], submit: true } });
    const id = placed.json.data.id as string;
    expect((await call(Orders, "POST", `${id}/rounds`, { token: captainB, key: `p6b-${RUN}`, body: { items: [{ menuItemId: dosa, qty: 1 }] } })).status).toBe(403);
    expect((await call(Orders, "POST", `${id}/rounds`, { token: foreign, key: `p6f-${RUN}`, body: { items: [{ menuItemId: dosa, qty: 1 }] } })).status).toBe(404);
    expect((await call(Orders, "POST", `${id}/request-bill`, { token: kitchen, body: {} })).status).toBe(403);
    const kot = (await prisma.kot.findFirstOrThrow({ where: { orderId: id } })).id;
    expect((await call(Kitchen, "POST", `kots/${kot}/status`, { token: captain, body: { status: "ACCEPTED" } })).status).toBe(403);
    // A captain cannot take payment or refund.
    const { POST: paymentsPost } = await import("@/app/api/payments/[[...path]]/route");
    expect((await call({ POST: paymentsPost }, "POST", "", { token: captain, key: `p6pay-${RUN}`, body: { orderId: id, method: "CASH", amount: 105 } })).status).toBe(403);
  });
});

describe("mobile read models over HTTP", () => {
  it("tables board and manager summary: RBAC, outlet required, foreign outlet 404", async () => {
    const board = await call(Mobile, "GET", "tables", { token: captain, query: { outletId: A } });
    expect(board.status).toBe(200);
    expect(board.json.data.tables.some((t: { id: string }) => t.id === tableA)).toBe(true);
    expect((await call(Mobile, "GET", "tables", { token: captain })).status).toBe(422);
    expect((await call(Mobile, "GET", "tables", { token: captainB, query: { outletId: A } })).status).toBe(403);
    expect((await call(Mobile, "GET", "tables", { token: foreign, query: { outletId: A } })).status).toBe(404);
    const m = await call(Mobile, "GET", "manager", { token: manager, query: { outletId: A } });
    expect(m.status).toBe(200);
    expect(m.json.data).toMatchObject({ sales: expect.any(Object), finance: expect.any(Object), inventory: expect.any(Object) });
    const c = await call(Mobile, "GET", "manager", { token: captain, query: { outletId: A } });
    expect(c.json.data).toMatchObject({ sales: null, finance: null, inventory: null });
    expect((await call(Mobile, "GET", "manager", { token: foreign, query: { outletId: A } })).status).toBe(404);
  });
});

describe("staff administration over HTTP", () => {
  it("needs password re-confirmation; no self-escalation; deactivation ends the session", async () => {
    const body = { email: `newcap-${RUN}@p6api.test`, name: "New Captain", role: "CAPTAIN", outletId: A };
    const first = await call(Staff, "POST", "", { token: manager, body });
    expect([first.status, first.json.error.code]).toEqual([403, "ReauthRequiredError"]);
    expect(await reauth(manager, "staff.manage")).toBe(200);
    const created = await call(Staff, "POST", "", { token: manager, body });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.json)).not.toMatch(/passwordHash/);
    expect((await call(Staff, "POST", "memberships", { token: manager, body: { userId: managerId, role: "OWNER" } })).status).toBe(403);
    expect((await call(Staff, "POST", "memberships", { token: manager, body: { userId: created.json.data.id, role: "MANAGER", outletId: A } })).status).toBe(403);
    expect((await call(Staff, "POST", "memberships", { token: manager, body: { userId: created.json.data.id, role: "CAPTAIN", outletId: B } })).status).toBe(403);
    expect((await call(Staff, "GET", "", { token: captain, query: { outletId: A } })).status).toBe(403);

    // Deactivating the captain revokes their session: the next request is 401.
    expect((await call(Staff, "POST", `users/${captainId}/active`, { token: manager, body: { active: false } })).status).toBe(200);
    expect((await call(Mobile, "GET", "tables", { token: captain, query: { outletId: A } })).status).toBe(401);
    expect((await call(Staff, "POST", `users/${captainId}/active`, { token: manager, body: { active: true } })).status).toBe(200);
    expect((await call(Mobile, "GET", "tables", { token: captain, query: { outletId: A } })).status).toBe(401); // old session stays revoked
  });
});
