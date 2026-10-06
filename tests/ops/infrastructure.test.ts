/**
 * Phase 9 production infrastructure:
 *  - structured logging: redaction of credentials / PII, request-id propagation, stacks only at error
 *  - production configuration validation (hard failures + boot warnings), never echoing secrets
 *  - liveness / readiness / combined health probes; migration awareness
 *  - graceful shutdown: in-flight requests drained, new API requests refused, shutdown tasks run
 *  - metrics endpoint authentication + Prometheus output; alert throttling + delivery
 *  - outbox worker: due retries (claimed once under concurrency), bounded give-up, stuck work recovery,
 *    housekeeping; webhook claims abandoned by a crash are re-processed exactly once
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { log, redact, scrub, setLogSink, withRequestContext } from "@/server/observability/log";
import { counterValue, inc, renderPrometheus, resetMetrics } from "@/server/observability/metrics";
import { raiseAlert, recordAuthFailure, resetAlerts, setAlertTransport } from "@/server/observability/alerts";
import { DEV_AUTH_SECRET_PLACEHOLDER, productionEnvWarnings, validateProductionEnv } from "@/server/config/env";
import { beginRequest, inFlight, isDraining, onShutdown, resetLifecycleForTests, shutdown } from "@/server/ops/lifecycle";
import { checkMigrations, EXPECTED_MIGRATION, readiness, resetReadinessCache } from "@/server/ops/readiness";
import { checkBackupFreshness, housekeeping, INTERRUPTED_MESSAGE, INTERRUPTED_PRINT, recoverStuckWork, retryDueDeliveries, runWorkerTick } from "@/server/ops/worker";
import { metricsAuthorized } from "@/server/ops/opsStatus";
import { GET as health } from "@/app/api/health/route";
import { GET as live } from "@/app/api/health/live/route";
import { GET as ready } from "@/app/api/health/ready/route";
import { GET as metrics } from "@/app/api/health/metrics/route";
import { GET as integrationsGet } from "@/app/api/integrations/[[...path]]/route";
import { checkIdempotency } from "@/server/services/pos";
import { upsertIntegration } from "@/server/services/integrations";
import { placeOrder, createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment } from "@/server/services/payment";
import { receiveWebhook } from "@/server/services/webhooks";
import { signPaymentPayload } from "@/integrations/payment";
import { bindWebhook } from "../domain/webhookBinding";

const RUN = Date.now().toString(36);
let orgId: string, outlet: string, tea: string;
let sys: AccessContext, owner: AccessContext;
let phoneSeq = 0;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Infra Org ${RUN}` } })).id;
  outlet = (await prisma.outlet.create({ data: { organizationId: orgId, code: `INF${RUN}`, name: "Infra" } })).id;
  sys = systemContext(orgId, [outlet]);
  owner = { ...sys, userId: `infra-owner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isSuperAdmin: false };
  tea = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `Tea ${RUN}`, price: 20, taxPct: 0 } })).id;
  await bindWebhook({ kind: "PAYMENT", provider: "mock", organizationId: orgId, externalRef: `acct-${orgId}` });
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(() => {
  resetLifecycleForTests();
  resetAlerts();
  setAlertTransport(null);
});

function capture() {
  const lines: { level: string; line: string }[] = [];
  const restore = setLogSink((level, line) => lines.push({ level, line }));
  return { lines, restore, text: () => lines.map((l) => l.line).join("\n") };
}

// ---------------------------------------------------------------- logging

describe("structured logging", () => {
  it("redacts credentials and masks PII in fields, nested objects and error messages", () => {
    const out = redact({
      password: "Hunter2!Hunter2!", authorization: "Bearer abc.def.ghi", apiKey: "k-123", nested: { webhookSecret: "s3cr3t", token: "t0k" },
      email: "guest@example.com", phone: "+919876543210", note: "postgresql://app:pw-in-url@db:5432/x and Bearer zzz.yyy",
      err: new Error("connect failed password=letmein for rzp_live_ABCDEF123"),
    }, true) as Record<string, any>;
    const text = JSON.stringify(out);
    for (const secret of ["Hunter2!Hunter2!", "abc.def.ghi", "k-123", "s3cr3t", "t0k", "pw-in-url", "zzz.yyy", "letmein", "ABCDEF123", "guest@", "9876543210"]) expect(text).not.toContain(secret);
    expect(out.email).toBe("g***@example.com");
    expect(out.phone).toBe("***3210");
    expect(out.err.stack).toBeDefined(); // stacks are kept server-side at error level
    expect(scrub("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [redacted]");
  });

  it("writes one JSON line per event carrying the request id; stacks only at error level", () => {
    const c = capture();
    const prevFmt = process.env.LOG_FORMAT, prevLvl = process.env.LOG_LEVEL;
    process.env.LOG_FORMAT = "json";
    process.env.LOG_LEVEL = "debug";
    try {
      withRequestContext({ requestId: "req-infra-0001" }, () => {
        log.info("hello", { event: "t", err: new Error("boom") });
        log.error("bad", { event: "t", error: new Error("kaboom") });
      });
      log.debug("outside");
    } finally {
      process.env.LOG_FORMAT = prevFmt;
      process.env.LOG_LEVEL = prevLvl;
      c.restore();
    }
    const [a, b, d] = c.lines.map((l) => JSON.parse(l.line));
    expect(a).toMatchObject({ level: "info", msg: "hello", requestId: "req-infra-0001", event: "t" });
    expect(a.err.stack).toBeUndefined();
    expect(b).toMatchObject({ level: "error", requestId: "req-infra-0001" });
    expect(b.error.stack).toContain("kaboom");
    expect(c.lines[1].level).toBe("error");
    expect(d.requestId).toBeUndefined();
  });

  it("an API 500 is logged (scrubbed, with stack) under its request id while the client sees only a generic message", async () => {
    const c = capture();
    let body: any;
    try {
      const { fail } = await import("@/server/api/respond");
      const res = withRequestContext({ requestId: "rid-infra-500-abc" }, () => fail(new Error("db password=topsecret exploded")));
      expect(res.status).toBe(500);
      body = await res.json();
    } finally {
      c.restore();
    }
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("topsecret");
    expect(JSON.stringify(body)).not.toContain("exploded");
    const logged = c.text();
    expect(logged).toContain("rid-infra-500-abc");
    expect(logged).toContain("exploded");
    expect(logged).not.toContain("topsecret");
  });
});

// ---------------------------------------------------------------- configuration

describe("production configuration (Phase 9)", () => {
  const base = { NODE_ENV: "production", DATABASE_URL: "postgresql://app@db/restora", AUTH_SECRET: "a-sufficiently-long-production-secret-value-0123456789" } as NodeJS.ProcessEnv;
  const fails = (over: Record<string, string>, re: RegExp) => expect(() => validateProductionEnv({ ...base, ...over })).toThrow(re);

  it("refuses development placeholder webhook secrets and mock providers unless mocks are explicitly allowed", () => {
    fails({ PAYMENT_WEBHOOK_SECRET: "dev-webhook-secret" }, /PAYMENT_WEBHOOK_SECRET must not use a development placeholder/);
    fails({ CRON_SECRET: "dev-cron-secret" }, /CRON_SECRET/);
    fails({ PAYMENT_PROVIDER: "mock" }, /PAYMENT_PROVIDER=mock is refused/);
    expect(() => validateProductionEnv({ ...base, PAYMENT_PROVIDER: "mock", PAYMENT_WEBHOOK_SECRET: "dev-webhook-secret", ALLOW_MOCK_PROVIDERS: "true" })).not.toThrow();
    const w = productionEnvWarnings({ ...base, ALLOW_MOCK_PROVIDERS: "true", PAYMENT_WEBHOOK_SECRET: "dev-webhook-secret" });
    expect(w.join("\n")).toMatch(/ALLOW_MOCK_PROVIDERS=true/);
    expect(w.join("\n")).toMatch(/PAYMENT_WEBHOOK_SECRET uses a development placeholder/);
  });

  it("refuses the demo seed flag, weak optional secrets, non-https public URLs and bad tuning values", () => {
    fails({ ALLOW_DEMO_SEED: "true" }, /ALLOW_DEMO_SEED/);
    fails({ INTEGRATION_SECRETS_KEY: "short" }, /INTEGRATION_SECRETS_KEY/);
    fails({ METRICS_TOKEN: "short" }, /METRICS_TOKEN/);
    fails({ PUBLIC_BASE_URL: "http://pos.example.com" }, /PUBLIC_BASE_URL must be an https/);
    fails({ NEXT_PUBLIC_SITE_URL: "http://restora.example" }, /NEXT_PUBLIC_SITE_URL must be an https/);
    fails({ ALERT_WEBHOOK_URL: "not a url" }, /ALERT_WEBHOOK_URL must be a valid URL/);
    fails({ RATE_LIMIT_STORE: "redis" }, /RATE_LIMIT_STORE/);
    fails({ LOG_LEVEL: "verbose" }, /LOG_LEVEL/);
    fails({ TRUSTED_PROXY_HOPS: "0" }, /TRUSTED_PROXY_HOPS/);
    fails({ SHUTDOWN_TIMEOUT_MS: "10" }, /SHUTDOWN_TIMEOUT_MS/);
    expect(() => validateProductionEnv({ ...base, PUBLIC_BASE_URL: "https://pos.example.com", ALERT_WEBHOOK_URL: "https://hooks.example.com/x", METRICS_TOKEN: "m".repeat(32), LOG_LEVEL: "warn" })).not.toThrow();
  });

  it("Razorpay must be fully configured; test keys are flagged; the emulator override is refused", () => {
    const rzp = { PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "rzp_live_AbC123", RAZORPAY_KEY_SECRET: "live-secret-value", RAZORPAY_WEBHOOK_SECRET: "webhook-secret-value" };
    expect(() => validateProductionEnv({ ...base, ...rzp })).not.toThrow();
    fails({ ...rzp, RAZORPAY_KEY_ID: "" }, /RAZORPAY_KEY_ID must be a Razorpay key id/);
    fails({ ...rzp, RAZORPAY_KEY_ID: "pk_live_123" }, /RAZORPAY_KEY_ID must be a Razorpay key id/);
    fails({ ...rzp, RAZORPAY_KEY_SECRET: "" }, /RAZORPAY_KEY_SECRET is required/);
    fails({ ...rzp, RAZORPAY_WEBHOOK_SECRET: "" }, /RAZORPAY_WEBHOOK_SECRET is required/);
    fails({ ...rzp, RAZORPAY_API_BASE: "http://localhost:9" }, /RAZORPAY_API_BASE/);
    let msg = "";
    try {
      validateProductionEnv({ ...base, ...rzp, RAZORPAY_KEY_SECRET: "", RAZORPAY_KEY_ID: "rzp_live_shown?no" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain("shown?no");
    expect(productionEnvWarnings({ ...base, ...rzp }).join("\n")).not.toMatch(/TEST key/);
    expect(productionEnvWarnings({ ...base, ...rzp, RAZORPAY_KEY_ID: "rzp_test_AbC123" }).join("\n")).toMatch(/RAZORPAY_KEY_ID is a TEST key/);
  });

  it("names variables and reasons only — never a value — and warns about risky defaults", () => {
    let msg = "";
    try {
      validateProductionEnv({ ...base, AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER, PAYMENT_WEBHOOK_SECRET: "dev-webhook-secret", METRICS_TOKEN: "tiny-token-value" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/AUTH_SECRET/);
    for (const v of [DEV_AUTH_SECRET_PLACEHOLDER, "dev-webhook-secret", "tiny-token-value"]) expect(msg).not.toContain(v);
    const w = productionEnvWarnings({ ...base, DATABASE_URL: "file:./x.db" }).join("\n");
    expect(w).toMatch(/SQLite/);
    expect(w).toMatch(/EXPORT_DIR/);
    expect(w).toMatch(/METRICS_TOKEN/);
    // Unset public addresses: QR codes would follow the viewer, the website would advertise localhost.
    expect(w).toMatch(/PUBLIC_BASE_URL is unset/);
    expect(w).toMatch(/NEXT_PUBLIC_SITE_URL is unset/);
    const set = productionEnvWarnings({ ...base, PUBLIC_BASE_URL: "https://pos.example.com", NEXT_PUBLIC_SITE_URL: "https://restora.example" }).join("\n");
    expect(set).not.toMatch(/PUBLIC_BASE_URL is unset|NEXT_PUBLIC_SITE_URL is unset/);
    expect(productionEnvWarnings({ ...base, DATABASE_URL: "file:./x.db", AHAROS_DESKTOP: "1" })).toEqual([]);
    expect(productionEnvWarnings({ NODE_ENV: "development" })).toEqual([]);
  });
});

// ---------------------------------------------------------------- health / readiness / shutdown

describe("health, readiness and graceful shutdown", () => {
  it("EXPECTED_MIGRATION is the newest migration of BOTH histories", () => {
    const newest = (dir: string) => fs.readdirSync(path.join(process.cwd(), dir)).filter((d) => /^\d{14}_/.test(d)).sort().at(-1);
    expect(newest("prisma/migrations")).toBe(EXPECTED_MIGRATION);
    expect(newest("prisma/postgres/migrations")).toBe(EXPECTED_MIGRATION);
  });

  it("liveness never touches the database; readiness and health report coarse states only", async () => {
    resetReadinessCache();
    const l = await live();
    expect(l.status).toBe(200);
    expect(await l.json()).toEqual({ ok: true, status: "alive" });
    const r = await ready();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, status: "ready", checks: { database: "up", migrations: "ok" } });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const h = await health();
    expect(h.status).toBe(200);
    expect(await checkMigrations(prisma)).toBe("ok");
  });

  it("a database that is unreachable is 'down' (503) without leaking connection details", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const dead = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL?.startsWith("postgres") ? "postgresql://nobody:pw-should-not-leak@127.0.0.1:1/x?connect_timeout=1" : "file:/nonexistent-dir-xyz/none.db" } } });
    const c = capture();
    try {
      const r = await readiness(dead);
      expect(r).toEqual({ ready: false, status: "not_ready", checks: { database: "down", migrations: "unknown" } });
    } finally {
      c.restore();
      await dead.$disconnect().catch(() => undefined);
    }
    expect(c.text()).not.toContain("pw-should-not-leak");
  });

  it("a half-applied or missing migration makes the instance not ready", async () => {
    resetReadinessCache();
    const fake = { $queryRawUnsafe: async () => [{ migration_name: EXPECTED_MIGRATION, finished_at: null, rolled_back_at: null }] } as never;
    const c = capture();
    try {
      expect(await checkMigrations(fake)).toBe("failed");
      resetReadinessCache();
      expect(await checkMigrations({ $queryRawUnsafe: async () => [{ migration_name: "20200101000000_old", finished_at: new Date(), rolled_back_at: null }] } as never)).toBe("pending");
    } finally {
      c.restore();
      resetReadinessCache();
    }
  });

  it("shutdown waits for in-flight requests, refuses new API requests with 503, then runs shutdown tasks in order", async () => {
    const order: string[] = [];
    onShutdown("first", async () => { order.push("first"); });
    onShutdown("second", async () => { order.push("second"); });
    const release = beginRequest()!;
    expect(inFlight()).toBe(1);
    const c = capture();
    const done = shutdown("TEST", { delayMs: 0, timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(isDraining()).toBe(true);
    expect(order).toEqual([]); // still waiting for the in-flight request
    expect(beginRequest()).toBeNull();
    const refused = await integrationsGet(new NextRequest("http://localhost/api/integrations"), { params: Promise.resolve({ path: [] }) });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect((await ready()).status).toBe(503);
    expect((await health()).status).toBe(503);
    expect((await live()).status).toBe(200); // still alive: do not restart a draining process
    release();
    await done;
    c.restore();
    expect(order).toEqual(["first", "second"]);
    expect(isDraining()).toBe(true); // stays down: the process is about to exit
  });

  it("a hung shutdown task cannot block exit beyond the deadline", async () => {
    onShutdown("hang", () => new Promise(() => undefined));
    const c = capture();
    const t0 = Date.now();
    await shutdown("TEST", { delayMs: 0, timeoutMs: 300 });
    c.restore();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(c.text()).toContain("shutdown task timed out");
  });
});

// ---------------------------------------------------------------- metrics / alerts

describe("metrics and alerts", () => {
  it("the metrics endpoint is off without METRICS_TOKEN and needs the bearer token when on", async () => {
    const prev = process.env.METRICS_TOKEN;
    try {
      delete process.env.METRICS_TOKEN;
      expect((await metrics(new Request("http://localhost/api/health/metrics"))).status).toBe(404);
      process.env.METRICS_TOKEN = "metrics-token-for-tests-0123456789";
      expect((await metrics(new Request("http://localhost/api/health/metrics"))).status).toBe(401);
      expect((await metrics(new Request("http://localhost/api/health/metrics", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
      inc("restora_http_requests_total", { class: "2xx" });
      const ok = await metrics(new Request("http://localhost/api/health/metrics", { headers: { authorization: "Bearer metrics-token-for-tests-0123456789" } }));
      expect(ok.status).toBe(200);
      const text = await ok.text();
      expect(text).toContain("# TYPE restora_http_requests_total counter");
      expect(text).toMatch(/restora_outbox_deliveries\{state="retry_scheduled"\} \d+/);
      expect(text).toContain("restora_process_uptime_seconds");
      expect(text).not.toContain(orgId); // aggregates only
      expect(metricsAuthorized("Bearer x", undefined)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = prev;
    }
  });

  it("label values are a bounded vocabulary (free text collapses to 'other')", () => {
    resetMetrics();
    inc("restora_webhooks_total", { kind: "payment", status: "a b c <script>" });
    expect(renderPrometheus()).toContain('restora_webhooks_total{kind="payment",status="other"} 1');
  });

  it("alerts are logged, throttled per key and POSTed (redacted) to ALERT_WEBHOOK_URL", async () => {
    const sent: string[] = [];
    setAlertTransport(async (_url, body) => { sent.push(body); });
    const prev = process.env.ALERT_WEBHOOK_URL;
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
    const c = capture();
    try {
      const t = Date.now();
      expect(raiseAlert("unit_test", "critical", "Something broke", { token: "tok-should-not-leak", count: 3 }, t)).toBe(true);
      expect(raiseAlert("unit_test", "critical", "Something broke", {}, t + 1_000)).toBe(false); // throttled
      expect(raiseAlert("unit_test", "critical", "Something broke", {}, t + 901_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      c.restore();
      if (prev === undefined) delete process.env.ALERT_WEBHOOK_URL;
      else process.env.ALERT_WEBHOOK_URL = prev;
    }
    expect(sent).toHaveLength(2);
    const body = JSON.parse(sent[0]);
    expect(body).toMatchObject({ source: "restora", key: "unit_test", severity: "critical", fields: { token: "[redacted]", count: 3 } });
    expect(sent.join()).not.toContain("tok-should-not-leak");
    expect(counterValue("restora_alerts_total", { key: "unit_test" })).toBeGreaterThanOrEqual(3);
  });

  it("repeated sign-in failures raise the brute-force alert", () => {
    const c = capture();
    const prev = process.env.ALERT_AUTH_FAILURE_THRESHOLD;
    process.env.ALERT_AUTH_FAILURE_THRESHOLD = "5";
    try {
      const t = Date.now();
      for (let i = 0; i < 5; i++) recordAuthFailure(t + i);
    } finally {
      c.restore();
      if (prev === undefined) delete process.env.ALERT_AUTH_FAILURE_THRESHOLD;
      else process.env.ALERT_AUTH_FAILURE_THRESHOLD = prev;
    }
    expect(c.text()).toContain('"alert"');
    expect(c.text()).toContain("auth_failures");
  });

  it("backup freshness: missing, failed and stale backups alert; a recent success is ok", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restora-bk-"));
    const file = path.join(dir, "last-backup.json");
    const prev = process.env.BACKUP_STATUS_FILE;
    process.env.BACKUP_STATUS_FILE = file;
    const c = capture();
    try {
      expect(await checkBackupFreshness()).toBe("stale"); // configured, but no successful backup recorded
      fs.writeFileSync(file, JSON.stringify({ lastSuccessAt: new Date().toISOString() }));
      expect(await checkBackupFreshness()).toBe("ok");
      fs.writeFileSync(file, JSON.stringify({ lastSuccessAt: new Date(Date.now() - 60_000).toISOString(), lastFailureAt: new Date().toISOString(), lastError: "pg_dump exited 1" }));
      expect(await checkBackupFreshness()).toBe("failed");
      fs.writeFileSync(file, JSON.stringify({ lastSuccessAt: new Date(Date.now() - 30 * 3600_000).toISOString() }));
      expect(await checkBackupFreshness()).toBe("stale");
      delete process.env.BACKUP_STATUS_FILE;
      expect(await checkBackupFreshness()).toBe("unconfigured");
    } finally {
      c.restore();
      if (prev === undefined) delete process.env.BACKUP_STATUS_FILE;
      else process.env.BACKUP_STATUS_FILE = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- worker / outbox

describe("outbox worker and crash recovery", () => {
  async function orderWithPhone() {
    const cust = await prisma.customer.create({ data: { organizationId: orgId, name: "Guest", phone: `98765${String(++phoneSeq).padStart(5, "0")}` } });
    return (await placeOrder(sys, { outletId: outlet, channel: "TAKEAWAY", submit: true, customerId: cust.id, items: [{ menuItemId: tea, qty: 1 }] })).id;
  }
  const delivery = (orderId: string, over: Record<string, unknown> = {}) =>
    prisma.integrationDelivery.create({
      data: { organizationId: orgId, outletId: outlet, kind: "MESSAGE", provider: "mock", mode: "MOCK", idempotencyKey: `infra:${RUN}:${Math.random().toString(36).slice(2)}`, target: "+91******2345", payload: JSON.stringify({ template: "ORDER_READY", channel: "SMS", body: "ready" }), sourceType: "Order", sourceId: orderId, maxAttempts: 3, ...over },
    });

  it("a due FAILED delivery is retried automatically, exactly once even with concurrent ticks; not-yet-due rows wait", async () => {
    await upsertIntegration(owner, { kind: "MESSAGING", provider: "mock", config: { channel: "SMS", templates: {} } });
    const orderId = await orderWithPhone();
    const due = await delivery(orderId, { status: "FAILED", attempts: 1, lastError: "Provider returned 503", nextAttemptAt: new Date(Date.now() - 1000) });
    const later = await delivery(orderId, { status: "FAILED", attempts: 1, nextAttemptAt: new Date(Date.now() + 3600_000) });
    const c = capture();
    try {
      await Promise.all([retryDueDeliveries(prisma), retryDueDeliveries(prisma), retryDueDeliveries(prisma)]);
    } finally {
      c.restore();
    }
    const d = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: due.id } });
    expect(d).toMatchObject({ status: "SENT", attempts: 2, nextAttemptAt: null, lastError: null });
    expect(await prisma.auditLog.count({ where: { entityType: "IntegrationDelivery", entityId: due.id, action: "MESSAGE_SEND" } })).toBe(1);
    expect(await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: later.id } })).toMatchObject({ status: "FAILED", attempts: 1 });
  });

  it("the last allowed attempt failing gives up (no more automatic retries) and raises an alert", async () => {
    const orderId = await orderWithPhone();
    await upsertIntegration(owner, { kind: "MESSAGING", provider: "mock", status: "DISCONNECTED" });
    const d = await delivery(orderId, { status: "FAILED", attempts: 2, nextAttemptAt: new Date(Date.now() - 1000) });
    const c = capture();
    let r;
    try {
      r = await retryDueDeliveries(prisma);
    } finally {
      c.restore();
    }
    expect(r.givenUp).toBeGreaterThanOrEqual(1);
    expect(await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "FAILED", attempts: 3, nextAttemptAt: null });
    expect(c.text()).toContain("integration_given_up");
    await upsertIntegration(owner, { kind: "MESSAGING", provider: "mock", status: "CONNECTED", config: { channel: "SMS", templates: {} } });
  });

  it("work interrupted by a crash is recovered: PENDING message -> FAILED (manual), QUEUED print -> FAILED, nothing auto-sent twice", async () => {
    const orderId = await orderWithPhone();
    const msg = await delivery(orderId, { status: "PENDING" });
    const printer = await prisma.printer.create({ data: { organizationId: orgId, outletId: outlet, name: `P-${RUN}-${Math.random().toString(36).slice(2, 6)}`, transport: "SIMULATED" } });
    const job = await prisma.printJob.create({ data: { organizationId: orgId, outletId: outlet, printerId: printer.id, kind: "KOT", dedupeKey: `infra-kot-${RUN}-${Math.random()}`, content: "x" } });
    // Fresh rows are in progress, not stuck.
    const c = capture();
    try {
      await recoverStuckWork(prisma, new Date());
      expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("PENDING");
      const later = new Date(Date.now() + 10 * 60_000);
      const r = await recoverStuckWork(prisma, later);
      expect(r.stuckDeliveries).toBeGreaterThanOrEqual(1);
      expect(r.stuckPrints).toBeGreaterThanOrEqual(1);
      // A second tick finds nothing new for these rows (idempotent recovery).
      await runWorkerTick(prisma, later, { housekeeping: false });
    } finally {
      c.restore();
    }
    expect(await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: msg.id } })).toMatchObject({ status: "FAILED", lastError: INTERRUPTED_MESSAGE, nextAttemptAt: null, attempts: 0 });
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "FAILED", lastError: INTERRUPTED_PRINT });
  });

  it("housekeeping deletes expired sessions and long-expired password links only", async () => {
    const u = await prisma.user.create({ data: { organizationId: orgId, email: `hk-${RUN}@x.test`, name: "HK", passwordHash: "x" } });
    const expired = await prisma.session.create({ data: { userId: u.id, tokenHash: `hk-exp-${RUN}`, expiresAt: new Date(Date.now() - 1000) } });
    const live = await prisma.session.create({ data: { userId: u.id, tokenHash: `hk-live-${RUN}`, expiresAt: new Date(Date.now() + 3600_000) } });
    const oldTok = await prisma.passwordToken.create({ data: { organizationId: orgId, userId: u.id, purpose: "RESET", tokenHash: `hk-old-${RUN}`, expiresAt: new Date(Date.now() - 8 * 86400_000) } });
    const recentTok = await prisma.passwordToken.create({ data: { organizationId: orgId, userId: u.id, purpose: "RESET", tokenHash: `hk-new-${RUN}`, expiresAt: new Date(Date.now() - 3600_000) } });
    const c = capture();
    try {
      await housekeeping(prisma);
    } finally {
      c.restore();
    }
    expect(await prisma.session.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(await prisma.passwordToken.findUnique({ where: { id: oldTok.id } })).toBeNull();
    expect(await prisma.passwordToken.findUnique({ where: { id: recentTok.id } })).not.toBeNull();
  });

  it("webhook claims: a live RECEIVED claim is a duplicate; an abandoned one is reclaimed by exactly one signed retry", async () => {
    const provider = `infra-${RUN}`;
    await prisma.webhookEvent.create({ data: { provider, eventId: "live", status: "RECEIVED", payload: "{}", signatureValid: true } });
    await prisma.webhookEvent.create({ data: { provider, eventId: "stale", status: "RECEIVED", payload: "{}", signatureValid: true, receivedAt: new Date(Date.now() - 10 * 60_000) } });
    const meta = { signatureValid: true, payload: "{}" };
    expect(await checkIdempotency(prisma, provider, "live", meta)).toEqual({ isNew: false });
    expect(await checkIdempotency(prisma, provider, "stale", { ...meta, signatureValid: false })).toEqual({ isNew: false }); // unsigned never reclaims
    const results = await Promise.all([1, 2, 3].map(() => checkIdempotency(prisma, provider, "stale", meta)));
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    expect(await checkIdempotency(prisma, provider, "stale", meta)).toEqual({ isNew: false }); // now freshly claimed
  });

  it("a payment capture whose processing died after the claim is applied once on the provider's retry (H1)", async () => {
    const ref = `crash-${RUN}`;
    const raw = JSON.stringify({ accountId: `acct-${orgId}`, eventId: `crash-ev-${RUN}`, event: "payment.captured", providerRef: ref, amount: 250 });
    const send = () => receiveWebhook({ kind: "PAYMENT", provider: "mock", rawBody: raw, signature: signPaymentPayload(raw) });
    // First delivery arrives before the payment exists -> FAILED row with the real (tenant-namespaced) event key.
    expect((await send()).status).toBe("FAILED");
    const ev = await prisma.webhookEvent.findFirstOrThrow({ where: { provider: "payment:mock", eventId: { contains: `crash-ev-${RUN}` } } });
    const o = await createOrder(sys, { outletId: outlet });
    await addOrderItem(sys, o.id, { name: "Online meal", qty: 1, unitPrice: 250 });
    const p = await createPayment(sys, o.id, { method: "ONLINE", amount: 250, provider: "mock", providerRef: ref });
    // Crash simulation: a delivery claimed the event (RECEIVED) and the process died before applying anything.
    await prisma.webhookEvent.update({ where: { id: ev.id }, data: { status: "RECEIVED", receivedAt: new Date() } });
    // While the claim is fresh it may still be in progress: a redelivery must not double-process.
    expect((await send()).status).toBe("DUPLICATE");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PENDING");
    // Before Phase 9 every later retry was answered DUPLICATE forever and the capture was lost.
    await prisma.webhookEvent.update({ where: { id: ev.id }, data: { receivedAt: new Date(Date.now() - 10 * 60_000) } });
    const retries = await Promise.all([send(), send()]);
    expect(retries.map((r) => r.status).sort()).toEqual(["DUPLICATE", "PROCESSED"]);
    expect((await send()).status).toBe("DUPLICATE");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("SUCCESS");
    expect(await prisma.payment.count({ where: { orderId: o.id, status: "SUCCESS" } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe("PROCESSED");
  });
});
