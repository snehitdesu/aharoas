/**
 * Background export hardening: explicit lifecycle, single execution under
 * concurrency, ORDERS CSV end to end, download security (IDOR, cross-org, storage
 * keys, traversal, non-SUCCESS / expired jobs), audit trail, retention and
 * restart recovery. Real services + real SQLite; storage is a temp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { buildAccessContext, systemContext } from "@/server/auth/context";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  BackgroundExportRunner, EXPORT_MESSAGES, LocalExportStorage, downloadExport, exportRetentionMs, getExportJob, processExportJob,
  purgeExpiredExports, recoverExportJobs, requestExport, toExportJobDTO, transitionExport, type ExportRunner, type ExportStorage,
} from "@/server/services/exportJobs";
import { createMenuItem } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createCustomer } from "@/server/services/crm";
import { createExpense } from "@/server/services/finance";
import { toCSV } from "@/domain/csv";
import * as Exports from "@/app/api/exports/[[...path]]/route";

const RUN = Date.now().toString(36);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aharos-exp-life-"));

/** Real local storage that also counts writes per key (detects duplicate generation). */
class CountingStorage implements ExportStorage {
  readonly inner = new LocalExportStorage(root);
  puts = new Map<string, number>();
  async put(key: string, content: string) {
    this.puts.set(key, (this.puts.get(key) ?? 0) + 1);
    await this.inner.put(key, content);
  }
  get(key: string) { return this.inner.get(key); }
  delete(key: string) { return this.inner.delete(key); }
}
/** Records enqueued ids without running them (lets a test act between request and execution). */
class DeferredRunner implements ExportRunner {
  jobs: string[] = [];
  async enqueue(id: string) { this.jobs.push(id); }
}

const storage = new CountingStorage();
let orgId: string, outletA: string, outletB: string;
let owner: AccessContext, mgrA: AccessContext, mgrA2: AccessContext, mgrB: AccessContext, cashierA: AccessContext, otherOrg: AccessContext;
let ownerToken: string, mgrA2Token: string;

async function user(tag: string, role: string, outletId: string | null) {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${tag}-${RUN}@life.test`, name: tag, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId, role } });
  return { ctx: await buildAccessContext(prisma, u.id), token: (await createSession(prisma, u.id)).token };
}

/** Request (deferred) and run one job with the counting storage; returns the final row. */
async function exportNow(ctx: AccessContext, report: string, filters: Record<string, unknown>) {
  const runner = new DeferredRunner();
  const job = await requestExport(ctx, report, filters, { runner });
  expect(job.status).toBe("PENDING");
  await processExportJob(job.id, { storage });
  return prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
}

const actionsFor = async (jobId: string) =>
  (await prisma.auditLog.findMany({ where: { entityType: "ExportJob", entityId: jobId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((a) => a.action);

/** Strict RFC 4180 parser (CRLF records, quoted fields with "" escapes and embedded newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') {
      if (field !== "") throw new Error(`quote inside unquoted field at ${i}`);
      quoted = true; i++; continue;
    }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" && text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 2; continue; }
    if (c === "\n" || c === "\r") throw new Error(`bare line break outside quotes at ${i}`);
    field += c; i++;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field !== "" || row.length) throw new Error("last record not CRLF-terminated");
  return rows;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Life Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `LA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `LB${RUN}`, name: "B" } })).id;
  const o = await user("owner", "OWNER", null);
  owner = o.ctx; ownerToken = o.token;
  mgrA = (await user("mgra", "MANAGER", outletA)).ctx;
  const m2 = await user("mgra2", "MANAGER", outletA);
  mgrA2 = m2.ctx; mgrA2Token = m2.token;
  mgrB = (await user("mgrb", "MANAGER", outletB)).ctx;
  cashierA = (await user("casha", "CASHIER", outletA)).ctx;
  otherOrg = systemContext((await prisma.organization.create({ data: { name: `Life Other ${RUN}` } })).id, []);
  await createExpense(owner, { outletId: outletA, category: "GAS", amount: 1200 });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle", () => {
  it("PENDING -> RUNNING -> SUCCESS with timestamps, retention deadline and the full audit trail", async () => {
    const job = await exportNow(mgrA, "EXPENSES", { outletId: outletA });
    expect(job.status).toBe("SUCCESS");
    expect(job.startedAt).toBeInstanceOf(Date);
    expect(job.finishedAt!.getTime()).toBeGreaterThanOrEqual(job.startedAt!.getTime());
    expect(job.expiresAt!.getTime() - job.finishedAt!.getTime()).toBe(exportRetentionMs());
    expect(exportRetentionMs({} as NodeJS.ProcessEnv)).toBe(168 * 3600_000); // default 7 days
    expect(storage.puts.get(job.filePath!)).toBe(1);
    await downloadExport(prisma, mgrA, job.id, storage);
    expect(await actionsFor(job.id)).toEqual(["EXPORT_REQUESTED", "EXPORT_STARTED", "EXPORT", "EXPORT_DOWNLOADED"]);
  });

  it("transitions are explicit: only legal moves from the expected current status", async () => {
    const job = await prisma.exportJob.create({ data: { organizationId: orgId, kind: "EXPENSES", status: "PENDING", requestedById: mgrA.userId } });
    expect(await transitionExport(prisma, job.id, "PENDING", "RUNNING")).toBe(true);
    expect(await transitionExport(prisma, job.id, "PENDING", "RUNNING")).toBe(false); // repeated: no longer PENDING
    expect(await transitionExport(prisma, job.id, "RUNNING", "SUCCESS")).toBe(true);
    expect(await transitionExport(prisma, job.id, "RUNNING", "FAILED")).toBe(false); // already SUCCESS
    await expect(transitionExport(prisma, job.id, "SUCCESS", "RUNNING")).rejects.toThrow(/Illegal export transition/);
    await expect(transitionExport(prisma, job.id, "FAILED", "SUCCESS")).rejects.toThrow(/Illegal/);
    // Denial and failures happen after the claim (RUNNING -> FAILED); PENDING -> FAILED is not a path.
    await expect(transitionExport(prisma, job.id, "PENDING", "FAILED")).rejects.toThrow(/Illegal/);
    await expect(transitionExport(prisma, job.id, "PENDING", "SUCCESS")).rejects.toThrow(/Illegal/);
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUCCESS");
  });

  it("a completed or failed job never runs again", async () => {
    const done = await exportNow(mgrA, "EXPENSES", { outletId: outletA });
    expect(await processExportJob(done.id, { storage })).toBe("SKIPPED");
    expect(storage.puts.get(done.filePath!)).toBe(1);
    const failed = await prisma.exportJob.create({ data: { organizationId: orgId, kind: "EXPENSES", status: "FAILED", requestedById: mgrA.userId, error: "x" } });
    expect(await processExportJob(failed.id, { storage })).toBe("SKIPPED");
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("FAILED");
  });

  it("RUNNING -> FAILED on an internal error: safe message, EXPORT_FAILED audit, no file left behind", async () => {
    const broken: ExportStorage = { put: async () => { throw new Error("disk exploded at /secret/path"); }, get: storage.get.bind(storage), delete: storage.delete.bind(storage) };
    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    expect(await processExportJob(job.id, { storage: broken })).toBe("FAILED");
    const after = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ status: "FAILED", error: EXPORT_MESSAGES.internal, filePath: null });
    expect(after.error).not.toContain("secret");
    expect(await actionsFor(job.id)).toEqual(["EXPORT_REQUESTED", "EXPORT_STARTED", "EXPORT_FAILED"]);
    await expect(downloadExport(prisma, mgrA, job.id, storage)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("runtime authorization", () => {
  it("permission revoked between request and execution: the runner refuses, nothing is generated", async () => {
    const runner = new DeferredRunner();
    const job = await requestExport(mgrA2, "EXPENSES", { outletId: outletA }, { runner });
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: mgrA2.userId } });
    await prisma.membership.update({ where: { id: m.id }, data: { role: "KITCHEN" } }); // no export.run / finance.view
    try {
      expect(await processExportJob(job.id, { storage })).toBe("DENIED");
    } finally {
      await prisma.membership.update({ where: { id: m.id }, data: { role: "MANAGER" } });
    }
    const after = await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ status: "FAILED", error: EXPORT_MESSAGES.denied, filePath: null, rowCount: null });
    expect(storage.puts.get(`${orgId}/${job.id}.csv`)).toBeUndefined();
    expect(await actionsFor(job.id)).toEqual(["EXPORT_REQUESTED", "EXPORT_STARTED", "EXPORT_DENIED"]);
  });

  it("a deactivated requester or a tampered job scope is denied", async () => {
    const job = await requestExport(mgrA2, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    await prisma.user.update({ where: { id: mgrA2.userId }, data: { active: false } });
    try {
      expect(await processExportJob(job.id, { storage })).toBe("DENIED");
    } finally {
      await prisma.user.update({ where: { id: mgrA2.userId }, data: { active: true } });
    }
    // Job row says outlet A but its stored filters were edited to outlet B.
    const tampered = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    await prisma.exportJob.update({ where: { id: tampered.id }, data: { params: JSON.stringify({ outletId: outletB, offset: 0 }) } });
    expect(await processExportJob(tampered.id, { storage })).toBe("DENIED");
  });
});

describe("concurrency", () => {
  it("two workers race for one PENDING job: exactly one claims it, the export is generated once", async () => {
    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    const outcomes = await Promise.all([processExportJob(job.id, { storage }), processExportJob(job.id, { storage })]);
    expect(outcomes.sort()).toEqual(["SKIPPED", "SUCCESS"]);
    expect(storage.puts.get(`${orgId}/${job.id}.csv`)).toBe(1);
    const actions = await actionsFor(job.id);
    expect(actions.filter((a) => a === "EXPORT_STARTED")).toHaveLength(1);
    expect(actions.filter((a) => a === "EXPORT")).toHaveLength(1);
  });

  it("two independent runners enqueueing the same job still run it once", async () => {
    const job = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    const r1 = new BackgroundExportRunner({ storage });
    const r2 = new BackgroundExportRunner({ storage });
    await Promise.all([r1.enqueue(job.id), r2.enqueue(job.id), r1.enqueue(job.id)]);
    await Promise.all([r1.idle(), r2.idle()]);
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUCCESS");
    expect(storage.puts.get(`${orgId}/${job.id}.csv`)).toBe(1);
  });
});

describe("ORDERS export (CSV end to end)", () => {
  it("exports real orders as valid RFC 4180 CSV: commas, quotes, newlines, Unicode, decimals, dates", async () => {
    const tricky = `Zoë "Chef" Ñúñez, Café 🍛\nAnnex`;
    const customer = await createCustomer(owner, { name: tricky, phone: `98${Date.now().toString().slice(-8)}` });
    const item = await createMenuItem(owner, { name: `Thali ${RUN}`, price: 199.5, taxPct: 5 });
    const order = await placeOrder(owner, { outletId: outletA, channel: "TAKEAWAY", customerId: customer.id, items: [{ menuItemId: item.id, qty: 2 }], submit: false });
    await placeOrder(owner, { outletId: outletB, channel: "TAKEAWAY", items: [{ menuItemId: item.id, qty: 1 }], submit: false }); // other outlet

    const job = await exportNow(mgrA, "ORDERS", { outletId: outletA });
    expect(job.status).toBe("SUCCESS");
    const { csv } = await downloadExport(prisma, mgrA, job.id, storage);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(["Date", "Outlet", "Order", "Invoice", "Channel", "Source", "Status", "Table", "Customer", "Covers", "Subtotal", "Discount", "Tax", "Total", "Paid"]);
    const data = rows.slice(1);
    expect(data).toHaveLength(1); // outlet B's order is not in outlet A's export
    expect(job.rowCount).toBe(1);
    const r = Object.fromEntries(rows[0].map((h, i) => [h, data[0][i]]));
    expect(r).toMatchObject({ Outlet: `LA${RUN}`, Order: order.id, Channel: "TAKEAWAY", Source: "POS", Status: "OPEN", Table: "", Customer: tricky, Covers: "1", Subtotal: "399", Discount: "0", Tax: "19.95", Total: "418.95", Paid: "", Invoice: "" });
    expect(new Date(r.Date).getTime()).toBe(new Date(order.createdAt).getTime()); // ISO-8601 timestamp
    expect(Buffer.from(csv, "utf8").toString("utf8")).toContain("🍛");
  });

  it("negative values and formula-looking text are encoded safely by the same encoder", () => {
    const csv = toCSV([{ a: -12.5, b: "-12.50", c: "=HYPERLINK(1)", d: "-x" }], [
      { header: "A", value: (r) => r.a }, { header: "B", value: (r) => r.b }, { header: "C", value: (r) => r.c }, { header: "D", value: (r) => r.d },
    ]);
    expect(parseCsv(csv)[1]).toEqual(["-12.5", "-12.50", "'=HYPERLINK(1)", "'-x"]);
  });
});

describe("download security", () => {
  it("IDOR, cross-organization and unauthorized access are refused", async () => {
    const job = await exportNow(mgrA, "EXPENSES", { outletId: outletA });
    await expect(downloadExport(prisma, mgrA2, job.id, storage)).rejects.toBeInstanceOf(ForbiddenError); // same org, another user's job
    await expect(downloadExport(prisma, mgrB, job.id, storage)).rejects.toBeInstanceOf(ForbiddenError); // other outlet
    await expect(downloadExport(prisma, cashierA, job.id, storage)).rejects.toBeInstanceOf(ForbiddenError); // no export.run
    await expect(downloadExport(prisma, otherOrg, job.id, storage)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getExportJob(prisma, otherOrg, job.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requestExport(cashierA, "EXPENSES", { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await downloadExport(prisma, owner, job.id, storage)).rowCount).toBe(1); // org-wide owner may
    expect((await actionsFor(job.id)).filter((a) => a === "EXPORT_DOWNLOADED")).toHaveLength(1); // refusals are not downloads
  });

  it("PENDING, RUNNING, FAILED and expired jobs cannot be downloaded", async () => {
    const pending = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    await expect(downloadExport(prisma, mgrA, pending.id, storage)).rejects.toThrow(/PENDING/);
    await transitionExport(prisma, pending.id, "PENDING", "RUNNING");
    await expect(downloadExport(prisma, mgrA, pending.id, storage)).rejects.toThrow(/RUNNING/);
    await transitionExport(prisma, pending.id, "RUNNING", "FAILED", { error: "x" });
    await expect(downloadExport(prisma, mgrA, pending.id, storage)).rejects.toThrow(/FAILED/);
    const done = await exportNow(mgrA, "EXPENSES", { outletId: outletA });
    await prisma.exportJob.update({ where: { id: done.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); // due, not yet purged
    await expect(downloadExport(prisma, mgrA, done.id, storage)).rejects.toThrow(/expired/);
  });

  it("a tampered storage key can never reach an arbitrary file (path traversal / absolute paths)", async () => {
    const outside = path.join(root, "..", `outside-${RUN}.csv`);
    fs.writeFileSync(outside, "secret");
    try {
      const job = await exportNow(mgrA, "EXPENSES", { outletId: outletA });
      for (const bad of [`../outside-${RUN}.csv`, `${orgId}/../../outside-${RUN}.csv`, outside, "/etc/passwd", "C:\\Windows\\win.ini", `${orgId}\\${job.id}.csv`, `${orgId}/${job.id}.csv/..`]) {
        await prisma.exportJob.update({ where: { id: job.id }, data: { filePath: bad } });
        await expect(downloadExport(prisma, mgrA, job.id, storage), bad).rejects.toBeInstanceOf(ValidationError);
      }
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("API responses never contain the storage key; the download is addressed by opaque id only", async () => {
    const job = await exportNow(owner, "EXPENSES", { outletId: outletA });
    const dto = toExportJobDTO(job);
    expect(dto).not.toHaveProperty("filePath");
    expect(dto.downloadable).toBe(true);
    const call = async (method: "GET" | "POST", p: string, token: string, body?: unknown) => {
      const req = new NextRequest(`http://localhost/api/exports/${p}`, { method, headers: { host: "localhost", origin: "http://localhost", cookie: `${SESSION_COOKIE}=${token}` }, body: body ? JSON.stringify(body) : undefined });
      const handler = (Exports as unknown as Record<string, (r: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>)[method];
      const res = await handler(req, { params: Promise.resolve({ path: p ? p.split("/") : undefined }) });
      return { status: res.status, text: await res.text(), headers: res.headers };
    };
    const one = await call("GET", job.id, ownerToken);
    const list = await call("GET", "", ownerToken);
    const queued = await call("POST", "", ownerToken, { report: "EXPENSES", filters: { outletId: outletA }, mode: "background" });
    for (const r of [one, list, queued]) {
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("filePath");
      expect(r.text).not.toContain(`${orgId}/`);
    }
    expect(JSON.parse(queued.text).data.status).toBe("PENDING");
    const dl = await call("GET", `${job.id}/download`, mgrA2Token); // another manager: IDOR over HTTP
    expect(dl.status).toBe(403);
    expect((await call("GET", `..%2F..%2Fetc%2Fpasswd/download`, ownerToken)).status).toBe(404);
  });
});

describe("retention", () => {
  it("keeps unexpired exports; expires due ones (file removed, audited); safe to repeat", async () => {
    const keep = await exportNow(mgrA, "EXPENSES", { outletId: outletA });
    const due = await exportNow(mgrA, "EXPENSES", { outletId: outletA });
    const running = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    await transitionExport(prisma, running.id, "PENDING", "RUNNING");
    const past = new Date(Date.now() - 60_000);
    await prisma.exportJob.update({ where: { id: due.id }, data: { expiresAt: past } });

    expect(await purgeExpiredExports({ storage })).toBeGreaterThanOrEqual(1);
    const kept = await prisma.exportJob.findUniqueOrThrow({ where: { id: keep.id } });
    expect(kept.status).toBe("SUCCESS");
    expect(await storage.get(kept.filePath!)).toContain("GAS");
    const expired = await prisma.exportJob.findUniqueOrThrow({ where: { id: due.id } });
    expect(expired).toMatchObject({ status: "EXPIRED", filePath: null });
    expect(expired.purgedAt).toBeInstanceOf(Date);
    await expect(storage.get(due.filePath!)).rejects.toThrow(); // file deleted
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("RUNNING"); // never touched
    expect((await actionsFor(due.id)).at(-1)).toBe("EXPORT_PURGED");
    await expect(downloadExport(prisma, mgrA, due.id, storage)).rejects.toThrow(/expired/);
    expect(toExportJobDTO(expired).downloadable).toBe(false);

    expect(await purgeExpiredExports({ storage })).toBe(0); // repeated run: nothing left to do
    expect((await actionsFor(due.id)).filter((a) => a === "EXPORT_PURGED")).toHaveLength(1);
    await transitionExport(prisma, running.id, "RUNNING", "FAILED", { error: "test cleanup" });
  });
});

describe("restart recovery", () => {
  it("stale RUNNING -> FAILED, fresh RUNNING untouched, PENDING re-queued; repeatable without duplicate execution", async () => {
    const stale = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    await transitionExport(prisma, stale.id, "PENDING", "RUNNING", { startedAt: new Date(Date.now() - 2 * 3600_000) });
    const fresh = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });
    await transitionExport(prisma, fresh.id, "PENDING", "RUNNING", { startedAt: new Date() });
    const pending = await requestExport(mgrA, "EXPENSES", { outletId: outletA }, { runner: new DeferredRunner() });

    const recording = new DeferredRunner();
    const first = await recoverExportJobs({ runner: recording, storage });
    expect(first.interrupted).toBeGreaterThanOrEqual(1);
    expect(recording.jobs).toContain(pending.id);
    expect(await prisma.exportJob.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: "FAILED", error: EXPORT_MESSAGES.interrupted });
    expect((await actionsFor(stale.id)).at(-1)).toBe("EXPORT_FAILED");
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("RUNNING");

    // Recovery again (e.g. two restarts / two instances), then a real runner drains both enqueues.
    const runner = new BackgroundExportRunner({ storage });
    const second = await recoverExportJobs({ runner, storage });
    expect(second.interrupted).toBe(0); // idempotent: the stale job was already handled
    await runner.enqueue(pending.id);
    await runner.idle();
    expect((await prisma.exportJob.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("SUCCESS");
    expect(storage.puts.get(`${orgId}/${pending.id}.csv`)).toBe(1);
    expect((await actionsFor(stale.id)).filter((a) => a === "EXPORT_FAILED")).toHaveLength(1);
    await transitionExport(prisma, fresh.id, "RUNNING", "FAILED", { error: "test cleanup" });
  });
});
