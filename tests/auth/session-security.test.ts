/**
 * H3 — shared POS session security, through the REAL route handlers:
 *  - step-up re-authentication: every sensitive endpoint refuses to run without
 *    a fresh, scoped grant on the calling session; succeeds with one; the grant
 *    is scope-bound, session-bound, expiring and never adds a permission;
 *  - the route tables cannot contain an unprotected duplicate/shadow of a
 *    protected endpoint (router ordering cannot bypass re-auth);
 *  - idle timeout: activity slides the window (throttled), background polling
 *    does not, an idle session is revoked server-side and stays dead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession, hashToken, validateSession, ACTIVITY_WRITE_INTERVAL_MS, sessionIdleTimeoutSeconds } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { assertUnambiguousRoutes } from "@/server/api/router";
import { BACKGROUND_HEADER, SESSION_COOKIE, REAUTH_SCOPES } from "@/constants/auth";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Payments from "@/app/api/payments/[[...path]]/route";
import * as Staff from "@/app/api/staff/[[...path]]/route";
import * as Master from "@/app/api/master/[[...path]]/route";
import * as Procurement from "@/app/api/procurement/[[...path]]/route";
import * as Finance from "@/app/api/finance/[[...path]]/route";
import * as System from "@/app/api/system/[[...path]]/route";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";
import { logout } from "@/server/auth/login";
import { POST as changeRoute } from "@/app/api/auth/password/change/route";

const RUN = Date.now().toString(36);
const PW = "Counter#Shift42";
let orgId: string, outletA: string, org2Id: string;
let ownerId: string, cashierId: string, foreignOwnerId: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost", ...opts.headers };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: (await res.json()) as any };
}
function authReq(path: string, token: string | null, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: "localhost", "x-forwarded-for": `10.3.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`, ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) },
  });
}
async function reauth(token: string, scope: string, password = PW) {
  const res = await reauthRoute(authReq("/api/auth/reauth", token, { password, scope }));
  return { status: res.status, json: (await res.json()) as any };
}
const session = (token: string) => prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
const login = async (userId: string) => (await createSession(prisma, userId)).token;

async function mkUser(org: string, tag: string, role: string, outletId: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${tag}-${RUN}@sess.test`, name: tag, passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId, role } });
  return u.id;
}

/** A PAID takeaway order with one verified cash payment of 100. */
async function paidOrder(token: string) {
  const orderId = (await call(Orders, "POST", "", { token, body: { outletId: outletA, channel: "TAKEAWAY" } })).json.data.id;
  await call(Orders, "POST", `${orderId}/items`, { token, body: { name: "Dosa", qty: 1, unitPrice: 100 } });
  const pay = (await call(Payments, "POST", "", { token, body: { orderId, method: "CASH", amount: 100 } })).json.data;
  expect((await call(Payments, "POST", `${pay.id}/verify`, { token })).json.data.orderSettled).toBe(true);
  return { orderId, paymentId: pay.id as string };
}
async function openOrder(token: string) {
  const id = (await call(Orders, "POST", "", { token, body: { outletId: outletA, channel: "TAKEAWAY" } })).json.data.id as string;
  await call(Orders, "POST", `${id}/items`, { token, body: { name: "Vada", qty: 1, unitPrice: 50 } });
  return id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Sess Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `SA${RUN}`, name: "A" } })).id;
  ownerId = await mkUser(orgId, "owner", "OWNER", null);
  cashierId = await mkUser(orgId, "cashier", "CASHIER", outletA);
  org2Id = (await prisma.organization.create({ data: { name: `Sess Org2 ${RUN}` } })).id;
  foreignOwnerId = await mkUser(org2Id, "owner2", "OWNER", null);
});
afterAll(async () => { await prisma.$disconnect(); });

// ---------------------------------------------------------------------------

describe("route tables: re-auth cannot be bypassed by duplicates or ordering", () => {
  const h = async () => null;
  it("rejects an unprotected duplicate placed before (or after) a protected endpoint", () => {
    expect(() => assertUnambiguousRoutes([
      { method: "POST", path: ":id/refund" },
      { method: "POST", path: ":id/refund", reauth: "payment.refund" },
    ])).toThrow(/Ambiguous API routes/);
    expect(() => assertUnambiguousRoutes([
      { method: "POST", path: "", reauth: "staff.manage" },
      { method: "POST", path: "" },
    ])).toThrow(/Ambiguous API routes/);
  });

  it("rejects a parameterised route that could shadow a protected one", () => {
    expect(() => assertUnambiguousRoutes([
      { method: "POST", path: ":id/:action" },
      { method: "POST", path: ":id/refund", reauth: "payment.refund" },
    ])).toThrow(/different protection/);
    expect(() => assertUnambiguousRoutes([
      { method: "DELETE", path: "memberships/:id", reauth: "staff.manage" },
      { method: "DELETE", path: ":kind/:id" },
    ])).toThrow(/different protection/);
  });

  it("allows the same path under different methods, and non-overlapping routes", () => {
    expect(() => assertUnambiguousRoutes([
      { method: "GET", path: "organization" },
      { method: "PATCH", path: "organization", reauth: "settings.manage" },
      { method: "POST", path: ":id/refund", reauth: "payment.refund" },
      { method: "POST", path: ":id/verify" },
    ])).not.toThrow();
    void h;
  });

  it("every real API route module passes the check at load time", async () => {
    const mods = await Promise.all([
      import("@/app/api/analytics/[[...path]]/route"), import("@/app/api/anomalies/[[...path]]/route"), import("@/app/api/audit/[[...path]]/route"),
      import("@/app/api/customers/[[...path]]/route"), import("@/app/api/exports/[[...path]]/route"), import("@/app/api/finance/[[...path]]/route"),
      import("@/app/api/inventory/[[...path]]/route"), import("@/app/api/kitchen/[[...path]]/route"), import("@/app/api/loyalty/[[...path]]/route"),
      import("@/app/api/master/[[...path]]/route"), import("@/app/api/menu/[[...path]]/route"), import("@/app/api/notifications/[[...path]]/route"),
      import("@/app/api/orders/[[...path]]/route"), import("@/app/api/payments/[[...path]]/route"), import("@/app/api/procurement/[[...path]]/route"),
      import("@/app/api/recipes/[[...path]]/route"), import("@/app/api/reports/[[...path]]/route"), import("@/app/api/reservations/[[...path]]/route"),
      import("@/app/api/staff/[[...path]]/route"), import("@/app/api/system/[[...path]]/route"),
    ]);
    expect(mods).toHaveLength(20);
  });
});

/**
 * Every sensitive endpoint, called by an OWNER (who holds every permission, so
 * a refusal can only come from the re-auth gate). Ids are placeholders: the
 * gate runs before the handler, so without a grant the answer is the re-auth
 * error; with the right grant the request reaches the service (404/422 for the
 * placeholder id) — proving the gate, not RBAC or validation, refused it.
 */
const SENSITIVE: Array<{ name: string; mod: object; method: string; path: string; scope: keyof typeof REAUTH_SCOPES; body?: unknown; passes?: number[] }> = [
  { name: "refund", mod: Payments, method: "POST", path: "nope-payment/refund", scope: "payment.refund", body: { amount: 1 } },
  { name: "order void/cancel", mod: Orders, method: "POST", path: "nope-order/cancel", scope: "order.void", body: { reason: "test void" } },
  { name: "purchase bill cancel", mod: Procurement, method: "POST", path: "bills/nope-bill/cancel", scope: "finance.void" },
  { name: "expense void", mod: Finance, method: "POST", path: "expenses/nope-expense/void", scope: "finance.void", body: { reason: "duplicate entry" } },
  { name: "vendor payment reversal", mod: Finance, method: "POST", path: "vendor-payments/nope-payment/reverse", scope: "finance.void", body: { reason: "cheque bounced" } },
  { name: "staff create", mod: Staff, method: "POST", path: "", scope: "staff.manage", body: { email: "not-an-email", name: "", role: "CASHIER" } },
  { name: "role grant", mod: Staff, method: "POST", path: "memberships", scope: "staff.manage", body: { userId: "nope-user", role: "CASHIER" } },
  { name: "role revoke", mod: Staff, method: "DELETE", path: "memberships/nope-membership", scope: "staff.manage" },
  { name: "staff (de)activate", mod: Staff, method: "POST", path: "users/nope-user/active", scope: "staff.manage", body: { active: false } },
  { name: "staff password link", mod: Staff, method: "POST", path: "users/nope-user/password-link", scope: "staff.manage" },
  { name: "organization settings", mod: Master, method: "PATCH", path: "organization", scope: "settings.manage", body: { name: "" } },
  { name: "outlet create", mod: Master, method: "POST", path: "outlets", scope: "settings.manage", body: { code: "", name: "" } },
  { name: "outlet update", mod: Master, method: "PATCH", path: "outlets/nope-outlet", scope: "settings.manage", body: {} },
  { name: "desktop backup restore", mod: System, method: "POST", path: "restore-authorization", scope: "backup.restore", passes: [200] },
];

describe("step-up re-authentication on every sensitive endpoint", () => {
  it.each(SENSITIVE)("$name ($method $path) is refused without a fresh grant and passes the gate with one", async ({ name, mod, method, path, scope, body, passes }) => {
    const token = await login(await mkUser(orgId, `owner-${name.replace(/\W+/g, "-")}`, "OWNER", null));
    const denied = await call(mod, method, path, { token, body });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("ReauthRequiredError");
    expect(denied.json.error.details).toEqual({ scope });

    // A grant for some OTHER scope does not open this endpoint.
    const other = Object.keys(REAUTH_SCOPES).find((s) => s !== scope)!;
    expect((await reauth(token, other)).status).toBe(200);
    expect((await call(mod, method, path, { token, body })).json.error.code).toBe("ReauthRequiredError");

    expect((await reauth(token, scope)).status).toBe(200);
    const passed = await call(mod, method, path, { token, body });
    expect(passed.json.error?.code).not.toBe("ReauthRequiredError");
    expect(passes ?? [404, 422]).toContain(passed.status); // reached the service: placeholder id / invalid input
  });

  it("refund: no refund without re-auth; succeeds after re-auth; audited", async () => {
    const token = await login(ownerId);
    const { paymentId, orderId } = await paidOrder(token);
    const denied = await call(Payments, "POST", `${paymentId}/refund`, { token, body: { amount: 40, reason: "cold food" } });
    expect(denied.status).toBe(403);
    expect(await prisma.refund.count({ where: { paymentId } })).toBe(0); // the service never ran

    // Client-side state cannot stand in for the grant.
    const forged = await call(Payments, "POST", `${paymentId}/refund`, { token, body: { amount: 40, reauth: true, reauthScope: "payment.refund" }, headers: { "x-reauth": "payment.refund" } });
    expect(forged.json.error.code).toBe("ReauthRequiredError");

    expect((await reauth(token, "payment.refund")).status).toBe(200);
    const ok = await call(Payments, "POST", `${paymentId}/refund`, { token, body: { amount: 40, reason: "cold food" } });
    expect(ok.status).toBe(200);
    expect(await prisma.refund.count({ where: { paymentId } })).toBe(1);
    const s = await session(token);
    expect(await prisma.auditLog.count({ where: { entityId: s.id, action: "REAUTH_SUCCEEDED" } })).toBe(1);
    const used = await prisma.auditLog.findFirst({ where: { entityId: s.id, action: "REAUTH_USED" } });
    expect(JSON.parse(used!.after!)).toMatchObject({ scope: "payment.refund", method: "POST" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).not.toBe("CANCELLED");
  });

  it("order cancel (void): refused without re-auth, order unchanged; cancels after re-auth", async () => {
    const token = await login(ownerId);
    const orderId = await openOrder(token);
    expect((await call(Orders, "POST", `${orderId}/cancel`, { token, body: { reason: "customer left" } })).status).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).not.toBe("CANCELLED");
    await reauth(token, "order.void");
    const ok = await call(Orders, "POST", `${orderId}/cancel`, { token, body: { reason: "customer left" } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.status).toBe("CANCELLED");
  });

  it("staff creation, role change and deactivation: refused without re-auth, applied after", async () => {
    const token = await login(ownerId);
    const email = `hire-${RUN}@sess.test`;
    const body = { email, name: "New Hire", role: "CASHIER", outletId: outletA };
    expect((await call(Staff, "POST", "", { token, body })).status).toBe(403);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    await reauth(token, "staff.manage");
    const created = await call(Staff, "POST", "", { token, body });
    expect(created.status).toBe(200);
    const hireId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

    const token2 = await login(ownerId); // a different session of the same owner has no grant
    expect((await call(Staff, "POST", "memberships", { token: token2, body: { userId: hireId, role: "MANAGER", outletId: outletA } })).json.error.code).toBe("ReauthRequiredError");
    expect(await prisma.membership.count({ where: { userId: hireId, role: "MANAGER" } })).toBe(0);
    expect((await call(Staff, "POST", "memberships", { token, body: { userId: hireId, role: "MANAGER", outletId: outletA } })).status).toBe(200);
    expect((await call(Staff, "POST", `users/${hireId}/active`, { token, body: { active: false } })).status).toBe(200);
  });

  it("organization settings: refused without re-auth, unchanged; applied after", async () => {
    const token = await login(ownerId);
    expect((await call(Master, "PATCH", "organization", { token, body: { name: "Renamed" } })).status).toBe(403);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).name).toBe(`Sess Org ${RUN}`);
    await reauth(token, "settings.manage");
    expect((await call(Master, "PATCH", "organization", { token, body: { name: `Sess Org ${RUN}` } })).status).toBe(200);
  });

  it("purchase bill cancel: refused without re-auth, bill stays OPEN; cancelled after re-auth", async () => {
    const token = await login(ownerId);
    const unit = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
    const vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Sess Vendor ${RUN}` } })).id;
    const materialId = (await prisma.material.create({ data: { organizationId: orgId, sku: `RICE-${RUN}`, name: "Rice", baseUnitId: unit } })).id;
    const bill = await call(Procurement, "POST", "bills", { token, body: { outletId: outletA, vendorId, lines: [{ materialId, qty: 2, rate: 50 }] } });
    expect(bill.status).toBe(200);
    const billId = bill.json.data.id as string;
    expect((await call(Procurement, "POST", `bills/${billId}/cancel`, { token })).json.error.code).toBe("ReauthRequiredError");
    expect((await prisma.purchaseBill.findUniqueOrThrow({ where: { id: billId } })).status).toBe("OPEN");
    await reauth(token, "finance.void");
    expect((await call(Procurement, "POST", `bills/${billId}/cancel`, { token })).status).toBe(200);
    expect((await prisma.purchaseBill.findUniqueOrThrow({ where: { id: billId } })).status).toBe("CANCELLED");
  });

  it("outlet create/update: refused without re-auth, nothing written; applied after", async () => {
    const token = await login(ownerId);
    const code = `N${RUN}`.slice(0, 20);
    expect((await call(Master, "POST", "outlets", { token, body: { code, name: "New" } })).status).toBe(403);
    expect(await prisma.outlet.count({ where: { organizationId: orgId, code } })).toBe(0);
    await reauth(token, "settings.manage");
    const created = await call(Master, "POST", "outlets", { token, body: { code, name: "New" } });
    expect(created.status).toBe(200);
    expect((await call(Master, "PATCH", `outlets/${created.json.data.id}`, { token, body: { name: "Renamed outlet" } })).status).toBe(200);
    const fresh = await login(ownerId);
    expect((await call(Master, "PATCH", `outlets/${created.json.data.id}`, { token: fresh, body: { name: "Hijack" } })).json.error.code).toBe("ReauthRequiredError");
    expect((await prisma.outlet.findUniqueOrThrow({ where: { id: created.json.data.id } })).name).toBe("Renamed outlet");
  });

  it("role revoke: refused without re-auth, membership kept; revoked after", async () => {
    const token = await login(ownerId);
    const victim = await mkUser(orgId, "revokee", "CASHIER", outletA);
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: victim } });
    expect((await call(Staff, "DELETE", `memberships/${m.id}`, { token })).status).toBe(403);
    expect(await prisma.membership.count({ where: { id: m.id } })).toBe(1);
    await reauth(token, "staff.manage");
    expect((await call(Staff, "DELETE", `memberships/${m.id}`, { token })).status).toBe(200);
  });

  it("a cross-origin request with a valid grant is rejected and does not record a re-auth use", async () => {
    const token = await login(ownerId);
    const orderId = await openOrder(token);
    await reauth(token, "order.void");
    const res = await call(Orders, "POST", `${orderId}/cancel`, { token, body: { reason: "csrf attempt" }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("ForbiddenError");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).not.toBe("CANCELLED");
    expect(await prisma.auditLog.count({ where: { entityId: (await session(token)).id, action: "REAUTH_USED" } })).toBe(0);
  });

  it("an expired grant is refused", async () => {
    const token = await login(ownerId);
    const orderId = await openOrder(token);
    await reauth(token, "order.void");
    await prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { reauthExpiresAt: new Date(Date.now() - 1000) } });
    expect((await call(Orders, "POST", `${orderId}/cancel`, { token, body: { reason: "expired grant" } })).json.error.code).toBe("ReauthRequiredError");
  });

  it("a wrong password grants nothing and is audited; the correct one succeeds", async () => {
    const token = await login(ownerId);
    const bad = await reauth(token, "payment.refund", "Wrong#Password1");
    expect(bad.status).toBe(422);
    const s = await session(token);
    expect(s.reauthScope).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: s.id, action: "REAUTH_FAILED" } })).toBe(1);
    expect((await reauth(token, "not.a.scope")).status).toBe(422);
    const good = await reauth(token, "payment.refund");
    expect(good.status).toBe(200);
    expect(good.json.data.scope).toBe("payment.refund");
    expect(JSON.stringify(good.json)).not.toContain(PW);
  });

  it("re-auth requires a session and is rate limited per user", async () => {
    expect((await reauthRoute(authReq("/api/auth/reauth", null, { password: PW, scope: "payment.refund" }))).status).toBe(401);
    expect((await reauthRoute(authReq("/api/auth/reauth", "forged-token", { password: PW, scope: "payment.refund" }))).status).toBe(401);
    const victimId = await mkUser(orgId, "ratelimited", "MANAGER", outletA);
    const token = await login(victimId);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await reauth(token, "payment.refund", "Wrong#Password1")).status;
    expect(last).toBe(429);
  });

  it("re-auth never adds a permission: a cashier with a refund grant still cannot refund", async () => {
    const ownerToken = await login(ownerId);
    const { paymentId } = await paidOrder(ownerToken);
    const token = await login(cashierId);
    expect((await reauth(token, "payment.refund")).status).toBe(200);
    const res = await call(Payments, "POST", `${paymentId}/refund`, { token, body: { amount: 10 } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("ForbiddenError");
    expect(await prisma.refund.count({ where: { paymentId } })).toBe(0);
  });

  it("restore authorization: a non-owner with a backup.restore grant is still refused", async () => {
    const token = await login(await mkUser(orgId, "mgr-restore", "MANAGER", outletA));
    expect((await reauth(token, "backup.restore")).status).toBe(200);
    const res = await call(System, "POST", "restore-authorization", { token });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("ForbiddenError");
  });

  it("tenant isolation: another organization's owner with a grant cannot refund or void here", async () => {
    const ownerToken = await login(ownerId);
    const { paymentId } = await paidOrder(ownerToken);
    const orderId = await openOrder(ownerToken);
    const token = await login(foreignOwnerId);
    await reauth(token, "payment.refund");
    expect((await call(Payments, "POST", `${paymentId}/refund`, { token, body: { amount: 10 } })).status).toBe(404);
    await reauth(token, "order.void");
    expect((await call(Orders, "POST", `${orderId}/cancel`, { token, body: { reason: "cross tenant" } })).status).toBe(404);
    expect(await prisma.refund.count({ where: { paymentId } })).toBe(0);
  });

  it("password change requires the current password (fresh authentication)", async () => {
    const id = await mkUser(orgId, "pwchange", "MANAGER", outletA);
    const token = await login(id);
    const wrong = await changeRoute(authReq("/api/auth/password/change", token, { currentPassword: "Wrong#Password1", newPassword: "Brand#NewPass99" }));
    expect(wrong.status).toBe(422);
    const ok = await changeRoute(authReq("/api/auth/password/change", token, { currentPassword: PW, newPassword: "Brand#NewPass99" }));
    expect(ok.status).toBe(200);
  });
});

describe("logout and revocation", () => {
  it("logout revokes the session and its grant; the cookie then fails everywhere", async () => {
    const token = await login(ownerId);
    const orderId = await openOrder(token);
    await reauth(token, "order.void");
    expect(await logout(prisma, token)).toBe(true);
    const s = await session(token);
    expect(s.revokedAt).not.toBeNull();
    expect(s.reauthScope).toBeNull();
    expect((await call(Orders, "POST", `${orderId}/cancel`, { token, body: { reason: "after logout" } })).status).toBe(401);
    expect((await reauth(token, "order.void")).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { entityId: s.id, action: "LOGOUT" } })).toBe(1);
  });

  it("a revoked session cannot call protected APIs", async () => {
    const token = await login(ownerId);
    await prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { revokedAt: new Date() } });
    expect((await call(Orders, "GET", "", { token, query: { outletId: outletA } })).status).toBe(401);
  });
});

describe("idle timeout", () => {
  const idleMs = () => sessionIdleTimeoutSeconds() * 1000;
  const setLast = (token: string, msAgo: number) => prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { lastActivityAt: new Date(Date.now() - msAgo) } });

  it("defaults to 15 minutes", () => {
    expect(sessionIdleTimeoutSeconds()).toBe(15 * 60);
  });

  it("an active session stays valid; activity slides the window but is written at most once a minute", async () => {
    const token = await login(ownerId);
    const created = (await session(token)).lastActivityAt!;
    expect((await call(Orders, "GET", "", { token, query: { outletId: outletA } })).status).toBe(200);
    expect((await session(token)).lastActivityAt!.getTime()).toBe(created.getTime()); // throttled: no write within a minute
    await setLast(token, idleMs() - 30_000); // 14.5 minutes idle
    expect((await call(Orders, "GET", "", { token, query: { outletId: outletA } })).status).toBe(200);
    expect(Date.now() - (await session(token)).lastActivityAt!.getTime()).toBeLessThan(ACTIVITY_WRITE_INTERVAL_MS);
  });

  it("an idle session is revoked server-side, audited, and cannot call protected APIs", async () => {
    const token = await login(ownerId);
    const orderId = await openOrder(token);
    await reauth(token, "order.void");
    await setLast(token, idleMs() + 1000);
    expect((await call(Orders, "GET", "", { token, query: { outletId: outletA } })).status).toBe(401);
    const s = await session(token);
    expect(s.revokedAt).not.toBeNull();
    expect(s.reauthScope).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: s.id, action: "SESSION_EXPIRED" } })).toBe(1);
    // Rewinding the activity clock does not revive it: revocation is permanent.
    await setLast(token, 0);
    expect((await call(Orders, "POST", `${orderId}/cancel`, { token, body: { reason: "after idle" } })).status).toBe(401);
    expect((await reauth(token, "order.void")).status).toBe(401);
  });

  it("background polling does not keep an idle session alive", async () => {
    const token = await login(ownerId);
    await setLast(token, idleMs() - 60_000); // 14 minutes idle
    const before = (await session(token)).lastActivityAt!.getTime();
    const poll = await call(Orders, "GET", "", { token, query: { outletId: outletA }, headers: { [BACKGROUND_HEADER]: "1" } });
    expect(poll.status).toBe(200); // still authenticated...
    expect((await session(token)).lastActivityAt!.getTime()).toBe(before); // ...but the poll did not count as activity
    await setLast(token, idleMs() + 1000);
    expect((await call(Orders, "GET", "", { token, query: { outletId: outletA }, headers: { [BACKGROUND_HEADER]: "1" } })).status).toBe(401);
  });

  it("validateSession honours the absolute expiry independently of activity", async () => {
    const token = await login(ownerId);
    await prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(Date.now() - 1000), lastActivityAt: new Date() } });
    expect(await validateSession(prisma, token, { activity: true })).toBeNull();
  });
});
