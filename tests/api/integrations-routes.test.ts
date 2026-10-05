/**
 * Phase 7 routes over HTTP (real handlers, sessions, services): integration
 * management needs integration.manage + password re-confirmation and never
 * returns a secret; printers need outlet.manage (+ re-confirmation); printing
 * and the drawer follow the order / payment permissions; the messaging status
 * webhook is public but signature-checked; cross-tenant ids are 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { SESSION_COOKIE } from "@/constants/auth";
import * as Integrations from "@/app/api/integrations/[[...path]]/route";
import * as Print from "@/app/api/print/[[...path]]/route";
import { POST as webhookRoute } from "@/app/api/webhooks/[kind]/[provider]/route";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";

const RUN = Date.now().toString(36);
const PW = "Integrations#Pass123";
let orgId: string, A: string;
let owner: string, manager: string, cashier: string, kitchen: string, foreign: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null), text: "" };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 7)}@p7api.test`, name: role, passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}
async function reauth(token: string, scope: string) {
  const req = new NextRequest("http://localhost/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PW, scope }), headers: { host: "localhost", "x-forwarded-for": `10.7.${Math.floor(Math.random() * 250)}.3`, cookie: `${SESSION_COOKIE}=${token}` } });
  return (await reauthRoute(req)).status;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `P7 API ${RUN}` } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P7X${RUN}`, name: "A" } })).id;
  owner = await session(orgId, "OWNER", null);
  manager = await session(orgId, "MANAGER", A);
  cashier = await session(orgId, "CASHIER", A);
  kitchen = await session(orgId, "KITCHEN", A);
  foreign = await session((await prisma.organization.create({ data: { name: `P7 API F ${RUN}` } })).id, "OWNER", null);
});
afterAll(async () => { await prisma.$disconnect(); });

describe("integration management over HTTP", () => {
  it("integration.manage + re-confirmation; credentials are write-only", async () => {
    expect((await call(Integrations, "GET", "", { token: manager })).status).toBe(403);
    const body = { kind: "MESSAGING", provider: "twilio", mode: "SANDBOX", credentials: { accountSid: `AC${"b".repeat(32)}`, authToken: "route-secret-token-0000000001" }, config: { channel: "SMS", templates: {} } };
    const first = await call(Integrations, "POST", "", { token: owner, body });
    expect([first.status, first.json.error.code]).toEqual([403, "ReauthRequiredError"]);
    expect(await reauth(owner, "settings.manage")).toBe(200);
    const saved = await call(Integrations, "POST", "", { token: owner, body });
    expect(saved.status).toBe(200);
    expect(saved.json.data).toMatchObject({ kind: "MESSAGING", provider: "twilio", mode: "SANDBOX", hasCredentials: true });
    const list = await call(Integrations, "GET", "", { token: owner });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain("route-secret-token-0000000001");
    expect(list.json.data.deployment.payment).toMatchObject({ provider: expect.any(String), mode: expect.stringMatching(/MOCK|SANDBOX|LIVE|UNAVAILABLE/) });
    const id = saved.json.data.id as string;
    expect((await call(Integrations, "POST", `${id}/test`, { token: foreign, body: {} })).status).toBe(404);
    expect((await call(Integrations, "GET", "deliveries", { token: cashier })).status).toBe(403);
    expect((await call(Integrations, "GET", "audit", { token: owner })).status).toBe(200);
  });

  it("accounting export needs finance.view + export.run", async () => {
    const range = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString() };
    expect((await call(Integrations, "POST", "accounting/export", { token: kitchen, body: { format: "generic", outletId: A, ...range } })).status).toBe(403);
    const ok = await call(Integrations, "POST", "accounting/export", { token: owner, body: { format: "generic", outletId: A, ...range } });
    expect(ok.status).toBe(200);
    expect((await call(Integrations, "POST", "accounting/export", { token: owner, body: { format: "generic", outletId: A, from: range.to, to: range.from } })).status).toBe(422);
  });
});

describe("printers over HTTP", () => {
  it("configuration needs outlet.manage + re-confirmation; unsafe hosts are 422; printing follows order permissions", async () => {
    expect((await call(Print, "POST", "printers", { token: cashier, body: { outletId: A, name: "X", role: "RECEIPT", transport: "SIMULATED" } })).status).toBe(403);
    expect(await reauth(manager, "settings.manage")).toBe(200);
    expect((await call(Print, "POST", "printers", { token: manager, body: { outletId: A, name: "Meta", role: "RECEIPT", transport: "NETWORK_ESCPOS", host: "169.254.169.254", port: 9100 } })).status).toBe(422);
    const p = await call(Print, "POST", "printers", { token: manager, body: { outletId: A, name: `Sim ${RUN}`, role: "RECEIPT", transport: "SIMULATED", cashDrawer: true } });
    expect(p.status).toBe(200);
    expect(p.json.data.mode).toBe("MOCK");
    expect((await call(Print, "GET", "printers", { token: cashier, query: { outletId: A } })).json.data).toHaveLength(1);
    expect((await call(Print, "GET", "printers", { token: foreign, query: { outletId: A } })).status).toBe(404);
    expect((await call(Print, "POST", `printers/${p.json.data.id}/test`, { token: cashier, body: {} })).status).toBe(403);
    const kick = await call(Print, "POST", "drawer/kick", { token: cashier, body: { outletId: A, reason: "Change" } });
    expect(kick.json.data).toMatchObject({ kicked: true, simulated: true });
    expect((await call(Print, "POST", "drawer/kick", { token: kitchen, body: { outletId: A, reason: "Change" } })).status).toBe(403);
    expect((await call(Print, "POST", "orders/not-an-order/receipt", { token: cashier, body: {} })).status).toBe(404);
    expect((await call(Print, "GET", "jobs", { token: cashier, query: { outletId: A } })).json.data.length).toBeGreaterThan(0);
  });
});

describe("messaging status webhook", () => {
  it("is public but signature-checked against the owning tenant's credentials", async () => {
    const d = await prisma.integrationDelivery.create({ data: { organizationId: orgId, kind: "MESSAGE", provider: "twilio", mode: "SANDBOX", idempotencyKey: `wh-${RUN}`, payload: "{}", status: "SENT", providerRef: `SM${RUN}` } });
    const form = new URLSearchParams({ MessageSid: `SM${RUN}`, MessageStatus: "delivered" }).toString();
    const post = (sig: string) => webhookRoute(new NextRequest("http://localhost/api/webhooks/messaging/twilio", { method: "POST", body: form, headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig } }), { params: Promise.resolve({ kind: "messaging", provider: "twilio" }) });
    expect((await post("forged")).status).toBe(401);
    const url = "http://localhost/api/webhooks/messaging/twilio";
    const sig = createHmac("sha1", "route-secret-token-0000000001").update(`${url}MessageSid${`SM${RUN}`}MessageStatusdelivered`).digest("base64");
    expect((await post(sig)).status).toBe(200);
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DELIVERED");
  });
});
