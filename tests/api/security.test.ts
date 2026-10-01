/**
 * Rate limiting, CSRF (Origin) checks and login hardening at the HTTP layer.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { hashPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import { MemoryRateLimitStore, enforceRateLimit, RateLimitError, getRateLimitStore, RATE_POLICIES, clientIp } from "@/server/api/rateLimit";
import { createRouter } from "@/server/api/router";
import { POST as login } from "@/app/api/auth/login/route";
import { getPaymentProvider } from "@/integrations/payment";
import { GET as health } from "@/app/api/health/route";
import { getPOSProvider } from "@/integrations/pos";
import { ProviderUnavailableError } from "@/integrations/policy";
import { POST as logout } from "@/app/api/auth/logout/route";

const RUN = Date.now().toString(36);
let orgId: string, userId: string, token: string;
const email = `sec-${RUN}@sec.test`;

const loginReq = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/auth/login", { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200) + 1}`, ...headers } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Sec Org ${RUN}` } })).id;
  userId = (await prisma.user.create({ data: { organizationId: orgId, email, name: "Sec", passwordHash: await hashPassword("Correct@123") } })).id;
  token = (await createSession(prisma, userId)).token;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("rate limit store", () => {
  it("counts per fixed window and resets after it", async () => {
    const store = new MemoryRateLimitStore();
    expect((await store.hit("k", 1000, 0)).count).toBe(1);
    expect((await store.hit("k", 1000, 500)).count).toBe(2);
    expect((await store.hit("k", 1000, 1000)).count).toBe(1); // new window
    expect((await store.hit("other", 1000, 1000)).count).toBe(1); // independent keys
  });

  it("enforceRateLimit throws 429 with Retry-After, and can be disabled", async () => {
    const policy = { name: `t-${RUN}`, limit: 2, windowMs: 60_000 };
    await enforceRateLimit(policy, "u", 0);
    await enforceRateLimit(policy, "u", 1);
    const err = await enforceRateLimit(policy, "u", 2).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(60);
    process.env.RATE_LIMIT_DISABLED = "true";
    try {
      await enforceRateLimit(policy, "u", 3); // no throw
    } finally {
      delete process.env.RATE_LIMIT_DISABLED;
    }
  });

  it("router routes can declare a policy (keyed per user)", async () => {
    const { GET } = createRouter([{ method: "GET", path: "ping", rateLimit: { name: `ping-${RUN}`, limit: 2, windowMs: 60_000 }, handler: async () => "pong" }]);
    const call = () => GET(new NextRequest("http://localhost/api/t/ping", { headers: { host: "localhost", cookie: `${SESSION_COOKIE}=${token}` } }), { params: Promise.resolve({ path: ["ping"] }) });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});

describe("login endpoint", () => {
  it("locks an account after repeated failures even across IPs", async () => {
    await getRateLimitStore().reset(`${RATE_POLICIES.loginPerEmail.name}:${email}`);
    for (let i = 0; i < RATE_POLICIES.loginPerEmail.limit; i++) {
      expect((await login(loginReq({ email, password: "wrong-password" }))).status).toBe(401);
    }
    const blocked = await login(loginReq({ email, password: "Correct@123" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("unknown accounts get the same 401 as wrong passwords", async () => {
    const res = await login(loginReq({ email: `nobody-${RUN}@sec.test`, password: "whatever" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid email or password");
  });

  it("rejects cross-origin login/logout, bad JSON and oversized bodies", async () => {
    expect((await login(loginReq({ email, password: "x" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await logout(new NextRequest("http://localhost/api/auth/logout", { method: "POST", headers: { host: "localhost", origin: "https://evil.example" } }))).status).toBe(403);
    const bad = new NextRequest("http://localhost/api/auth/login", { method: "POST", body: "{nope", headers: { host: "localhost" } });
    expect((await login(bad)).status).toBe(422);
    const huge = new NextRequest("http://localhost/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "x".repeat(20_000) }), headers: { host: "localhost" } });
    expect((await login(huge)).status).toBe(422);
  });
});

describe("client IP for rate limiting", () => {
  const req = (xff?: string, realIp?: string) => new Request("http://localhost/api/auth/login", { headers: { ...(xff ? { "x-forwarded-for": xff } : {}), ...(realIp ? { "x-real-ip": realIp } : {}) } });

  it("reads the address appended by our proxy, not the client-controlled left side", () => {
    // Client sends a forged XFF; the proxy appends the real peer address.
    expect(clientIp(req("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(req("1.1.1.1, 2.2.2.2, 203.0.113.9"))).toBe("203.0.113.9");
    // Two trusted hops (CDN -> load balancer -> app): the CDN's view of the client.
    expect(clientIp(req("6.6.6.6, 198.51.100.7, 10.0.0.2"), 2)).toBe("198.51.100.7");
  });

  it("rotating the forged part no longer yields a fresh rate-limit bucket", () => {
    const seen = new Set(Array.from({ length: 20 }, (_, i) => clientIp(req(`10.9.9.${i}, 203.0.113.9`))));
    expect([...seen]).toEqual(["203.0.113.9"]);
  });

  it("falls back sanely without a proxy header", () => {
    expect(clientIp(req(undefined, "192.0.2.5"))).toBe("192.0.2.5");
    expect(clientIp(req())).toBe("unknown");
    expect(clientIp(req("192.0.2.1"), 2)).toBe("192.0.2.1");
  });
});

describe("mock providers in production", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("the payment and POS factories refuse mocks in production unless explicitly allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_MOCK_PROVIDERS", "false");
    expect(() => getPaymentProvider("mock")).toThrow(ProviderUnavailableError);
    expect(() => getPaymentProvider()).toThrow(/disabled in production/); // PAYMENT_PROVIDER unset -> mock
    expect(() => getPOSProvider("mock")).toThrow(ProviderUnavailableError);
    vi.stubEnv("ALLOW_MOCK_PROVIDERS", "true");
    expect(getPaymentProvider("mock").name).toBe("mock");
    expect(getPOSProvider("mock").name).toBe("mock");
  });

  it("unknown provider names fail loudly instead of falling back to the mock", () => {
    expect(() => getPaymentProvider("stripe-typo")).toThrow(/Unknown payment provider "stripe-typo"/);
    expect(() => getPOSProvider("posist")).toThrow(/Unknown POS provider "posist"/);
    expect(new ProviderUnavailableError("x").status).toBe(503);
  });
});

describe("health check", () => {
  it("reports the database without authentication and without leaking details", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, db: "up" });
    expect(Object.keys(body).sort()).toEqual(["db", "latencyMs", "ok"]);
  });
});
