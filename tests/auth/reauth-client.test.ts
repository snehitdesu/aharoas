/**
 * H3 UI ↔ API integration: the REAL browser client (`api()` + its re-auth
 * retry) talking to the REAL route handlers and database. `fetch` is shimmed to
 * dispatch to the Next route modules with the terminal's session cookie; the
 * password prompt is driven programmatically exactly like ReauthProvider
 * (POST /api/auth/reauth, then "granted" only on the server's 200).
 * Proves the data effects: cancel / wrong password change nothing, the right
 * password performs the operation exactly once, an expired grant or ended
 * session fails safely without loops, and re-auth never adds a privilege.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession, hashToken } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { logout } from "@/server/auth/login";
import { SESSION_COOKIE } from "@/constants/auth";
import { api, request, setReauthPrompt, ApiError, type ReauthOutcome } from "@/lib/api/client";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Payments from "@/app/api/payments/[[...path]]/route";
import * as Staff from "@/app/api/staff/[[...path]]/route";
import * as Master from "@/app/api/master/[[...path]]/route";
import * as Procurement from "@/app/api/procurement/[[...path]]/route";
import * as System from "@/app/api/system/[[...path]]/route";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";

const RUN = Date.now().toString(36);
/** For calls that must fail: the error, typed; a success fails the test. */
const unexpected = (): ApiError => { throw new Error("expected the call to fail"); };
const PW = "Terminal#Shift42";
let orgId: string, outletA: string, ownerId: string, cashierId: string;

type Handler = (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>;
const MODULES: Record<string, Record<string, Handler>> = { orders: Orders as never, payments: Payments as never, staff: Staff as never, master: Master as never, procurement: Procurement as never, system: System as never };

/** The terminal: one session cookie, every API call routed to the real handler. */
let cookie: string | null = null;
let ip = 1;
function installTerminal() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, "http://localhost");
    const headers = new Headers(init.headers as Record<string, string>);
    headers.set("host", "localhost");
    headers.set("x-forwarded-for", `10.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`);
    if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
    const req = new NextRequest(u, { method: init.method ?? "GET", headers, body: init.body as string | undefined });
    if (u.pathname === "/api/auth/reauth") return reauthRoute(req);
    const [, , domain, ...rest] = u.pathname.split("/");
    const mod = MODULES[domain];
    return mod[req.method](req, { params: Promise.resolve({ path: rest.length ? rest : undefined }) });
  }));
}

/** ReauthProvider's behaviour, scripted: the operator types `typed` (null = presses Cancel). */
let typed: string | null;
let prompts: string[];
let afterGrant: (() => Promise<void>) | null;
const scriptedPrompt = async ({ scope }: { scope: string }): Promise<ReauthOutcome> => {
  prompts.push(scope);
  if (typed === null) return "cancelled";
  try {
    await request("/api/auth/reauth", { method: "POST", body: { password: typed, scope } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return "session_ended";
    return "cancelled"; // wrong password, then the operator gives up
  }
  await afterGrant?.();
  return "granted";
};

const login = async (userId: string) => (cookie = (await createSession(prisma, userId)).token);
async function mkUser(tag: string, role: string, outletId: string | null) {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${tag}-${RUN}@rc.test`, name: tag, passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId, role } });
  return u.id;
}
async function paidOrder() {
  const order = await api<{ id: string }>("/api/orders", { method: "POST", body: { outletId: outletA, channel: "TAKEAWAY" } });
  await api(`/api/orders/${order.id}/items`, { method: "POST", body: { name: "Idli", qty: 1, unitPrice: 100 } });
  const pay = await api<{ id: string }>("/api/payments", { method: "POST", body: { orderId: order.id, method: "CASH", amount: 100 } });
  await api(`/api/payments/${pay.id}/verify`, { method: "POST" });
  return { orderId: order.id, paymentId: pay.id };
}
async function openOrder() {
  const order = await api<{ id: string }>("/api/orders", { method: "POST", body: { outletId: outletA, channel: "TAKEAWAY" } });
  await api(`/api/orders/${order.id}/items`, { method: "POST", body: { name: "Vada", qty: 1, unitPrice: 50 } });
  return order.id;
}
const refunds = (paymentId: string) => prisma.refund.count({ where: { paymentId } });
const orderStatus = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `RC Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RC${RUN}`, name: "A" } })).id;
  ownerId = await mkUser("owner", "OWNER", null);
  cashierId = await mkUser("cashier", "CASHIER", outletA);
});
beforeEach(() => {
  installTerminal();
  typed = PW;
  prompts = [];
  afterGrant = null;
  cookie = null;
});
let uninstall: () => void = () => undefined;
beforeEach(() => { uninstall = setReauthPrompt(scriptedPrompt); });
afterEach(() => { uninstall(); vi.unstubAllGlobals(); });
afterAll(async () => { await prisma.$disconnect(); });

describe("refund through the real client", () => {
  it("cancel → no refund; wrong password → no refund; correct password → exactly one refund", async () => {
    await login(ownerId);
    const { paymentId } = await paidOrder();

    typed = null;
    const cancelled = await api(`/api/payments/${paymentId}/refund`, { method: "POST", body: { amount: 40, reason: "cold" } }).then(unexpected, (e: ApiError) => e);
    expect(cancelled.code).toBe("ReauthCancelled");
    expect(await refunds(paymentId)).toBe(0);

    typed = "Wrong#Password9";
    expect((await api(`/api/payments/${paymentId}/refund`, { method: "POST", body: { amount: 40, reason: "cold" } }).then(unexpected, (e: ApiError) => e)).code).toBe("ReauthCancelled");
    expect(await refunds(paymentId)).toBe(0);
    const s = await prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(cookie!) } });
    expect(s.reauthScope).toBeNull();

    typed = PW;
    const refund = await api<{ refund: { id: string }; duplicate?: boolean }>(`/api/payments/${paymentId}/refund`, { method: "POST", body: { amount: 40, reason: "cold" }, idempotencyKey: `rf-${RUN}` });
    expect(refund.refund.id).toBeTruthy();
    expect(refund.duplicate).toBeFalsy(); // the retry performed it; it is not a replay of an earlier success
    expect(await refunds(paymentId)).toBe(1); // performed once, not twice
    expect(prompts).toEqual(["payment.refund", "payment.refund", "payment.refund"]);

    // The grant now covers this session for a few minutes: no new prompt, still one refund per call.
    await api(`/api/payments/${paymentId}/refund`, { method: "POST", body: { amount: 10, reason: "extra" } });
    expect(prompts).toHaveLength(3);
    expect(await refunds(paymentId)).toBe(2);
  });
});

describe("order void through the real client", () => {
  it("is cancelled only after re-auth, exactly once", async () => {
    await login(ownerId);
    const orderId = await openOrder();
    typed = null;
    await api(`/api/orders/${orderId}/cancel`, { method: "POST", body: { reason: "guest left" } }).catch(() => null);
    expect(await orderStatus(orderId)).not.toBe("CANCELLED");
    typed = PW;
    const res = await api<{ status: string }>(`/api/orders/${orderId}/cancel`, { method: "POST", body: { reason: "guest left" } });
    expect(res.status).toBe("CANCELLED");
    expect(await prisma.auditLog.count({ where: { entityId: orderId, action: { contains: "CANCEL" } } })).toBeLessThanOrEqual(1);
  });

  it("an expired grant: the single retry is refused, nothing changes, no second prompt", async () => {
    await login(ownerId);
    const orderId = await openOrder();
    afterGrant = async () => {
      await prisma.session.update({ where: { tokenHash: hashToken(cookie!) }, data: { reauthExpiresAt: new Date(Date.now() - 1000) } });
    };
    const err = await api(`/api/orders/${orderId}/cancel`, { method: "POST", body: { reason: "expired" } }).then(unexpected, (e: ApiError) => e);
    expect(err.code).toBe("ReauthRequiredError");
    expect(prompts).toEqual(["order.void"]);
    expect(await orderStatus(orderId)).not.toBe("CANCELLED");
  });
});

describe("session end", () => {
  it("logout before confirming: the dialog's password check gets 401 and the action reports the ended session", async () => {
    await login(ownerId);
    const orderId = await openOrder();
    const token = cookie!;
    // The session is logged out (e.g. from another tab) while the dialog is open.
    const original = scriptedPrompt;
    uninstall();
    uninstall = setReauthPrompt(async (r) => { await logout(prisma, token); return original(r); });
    const err = await api(`/api/orders/${orderId}/cancel`, { method: "POST", body: { reason: "after logout" } }).then(unexpected, (e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(await orderStatus(orderId)).not.toBe("CANCELLED");
  });

  it("a revoked session never even reaches the prompt", async () => {
    await login(ownerId);
    const orderId = await openOrder();
    await prisma.session.update({ where: { tokenHash: hashToken(cookie!) }, data: { revokedAt: new Date() } });
    const err = await api(`/api/orders/${orderId}/cancel`, { method: "POST", body: { reason: "revoked" } }).then(unexpected, (e: ApiError) => e);
    expect(err.status).toBe(401);
    expect(prompts).toEqual([]);
  });
});

describe("no privilege gain through re-auth", () => {
  it("a cashier who confirms their password still cannot refund, create staff, or authorize a restore", async () => {
    await login(ownerId);
    const { paymentId } = await paidOrder();
    await login(cashierId);
    const refund = await api(`/api/payments/${paymentId}/refund`, { method: "POST", body: { amount: 10 } }).then(unexpected, (e: ApiError) => e);
    // The cashier's role lacks payment.refund: RBAC answers before or after the gate, never success.
    // The gate asks first; the cashier's own password is accepted, then RBAC refuses the retry.
    expect(refund.status).toBe(403);
    expect(refund.code).toBe("ForbiddenError");
    expect(prompts).toContain("payment.refund");
    expect(await refunds(paymentId)).toBe(0);

    const staff = await api("/api/staff", { method: "POST", body: { email: `x-${RUN}@rc.test`, name: "X", role: "OWNER" } }).then(unexpected, (e: ApiError) => e);
    expect(staff.code).toBe("ForbiddenError");
    expect(await prisma.user.count({ where: { email: `x-${RUN}@rc.test` } })).toBe(0);

    const restore = await api("/api/system/restore-authorization", { method: "POST" }).then(unexpected, (e: ApiError) => e);
    expect(restore.code).toBe("ForbiddenError");
  });
});

describe("other protected flows through the real client", () => {
  it("staff creation, role change, deactivation, password link, settings and outlets each prompt and then succeed once", async () => {
    await login(ownerId);
    const email = `hire-${RUN}@rc.test`;
    await api("/api/staff", { method: "POST", body: { email, name: "Hire", role: "CASHIER", outletId: outletA } });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    const hireId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    await api("/api/staff/memberships", { method: "POST", body: { userId: hireId, role: "MANAGER", outletId: outletA } });
    expect(await prisma.membership.count({ where: { userId: hireId, role: "MANAGER" } })).toBe(1);
    await api(`/api/staff/users/${hireId}/password-link`, { method: "POST" });
    await api(`/api/staff/users/${hireId}/active`, { method: "POST", body: { active: false } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: hireId } })).active).toBe(false);
    expect(prompts).toEqual(["staff.manage"]); // one confirmation covers the scope for a few minutes

    await api("/api/master/organization", { method: "PATCH", body: { name: `RC Org ${RUN}` } });
    const outlet = await api<{ id: string }>("/api/master/outlets", { method: "POST", body: { code: `O${RUN}`.slice(0, 20), name: "Second" } });
    await api(`/api/master/outlets/${outlet.id}`, { method: "PATCH", body: { name: "Second outlet" } });
    expect(await prisma.outlet.count({ where: { organizationId: orgId, code: `O${RUN}`.slice(0, 20) } })).toBe(1);
    expect(prompts).toEqual(["staff.manage", "settings.manage"]);
  });

  it("purchase bill cancel prompts with finance.void", async () => {
    await login(ownerId);
    const unit = (await prisma.unit.create({ data: { organizationId: orgId, code: `rc${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
    const vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `RC Vendor ${RUN}` } })).id;
    const materialId = (await prisma.material.create({ data: { organizationId: orgId, sku: `RC-${RUN}`, name: "Dal", baseUnitId: unit } })).id;
    const bill = await api<{ id: string }>("/api/procurement/bills", { method: "POST", body: { outletId: outletA, vendorId, lines: [{ materialId, qty: 1, rate: 10 }] } });
    typed = null;
    await api(`/api/procurement/bills/${bill.id}/cancel`, { method: "POST" }).catch(() => null);
    expect((await prisma.purchaseBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("OPEN");
    typed = PW;
    await api(`/api/procurement/bills/${bill.id}/cancel`, { method: "POST" });
    expect((await prisma.purchaseBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("CANCELLED");
    expect(prompts).toEqual(["finance.void", "finance.void"]);
  });

  it("desktop restore authorization: owner only, after a backup.restore confirmation", async () => {
    await login(ownerId);
    typed = null;
    expect((await api("/api/system/restore-authorization", { method: "POST" }).then(unexpected, (e: ApiError) => e)).code).toBe("ReauthCancelled");
    typed = PW;
    expect(await api("/api/system/restore-authorization", { method: "POST" })).toMatchObject({ authorized: true });
    expect(prompts).toEqual(["backup.restore", "backup.restore"]);
  });
});
