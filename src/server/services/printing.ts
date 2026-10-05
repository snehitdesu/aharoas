/**
 * Printing & cash drawer (Phase 7). Business events never wait on, or depend
 * on, a printer: a print is a PrintJob with its own status; a printer that is
 * off produces a FAILED job (retryable, bounded), never a failed order,
 * payment or drawer movement.
 *
 *  - First prints are de-duplicated: one `receipt:<order>:<printer>` and one
 *    `kot:<kot>:<printer>` job ever (a double tap / repeated auto-print
 *    returns the existing job). Reprints are separate jobs that need a reason
 *    and are audited.
 *  - KOT routing: a KOT printer with `station` set prints that station's
 *    tickets; without it, every station's.
 *  - SIMULATED printers (no hardware) mark jobs SIMULATED — never PRINTED.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { assertCan, can } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { getOrderBill, orderRef } from "@/server/services/bill";
import { bytes, kotDoc, plain, receiptDoc, testDoc, type Doc } from "@/integrations/printer/escpos";
import { printerAddressProblem, probePrinter, sendToPrinter } from "@/integrations/printer";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

export const MAX_PRINT_ATTEMPTS = 5;

const printerSchema = z
  .object({
    outletId: z.string().min(1),
    name: z.string().trim().min(1).max(60),
    role: z.enum(["RECEIPT", "KOT"]),
    station: z.string().trim().min(1).max(40).nullish(),
    transport: z.enum(["NETWORK_ESCPOS", "SIMULATED"]),
    host: z.string().trim().max(45).nullish(),
    port: z.number().int().min(1).max(65535).default(9100),
    width: z.number().int().min(24).max(64).default(42),
    cashDrawer: z.boolean().default(false),
    autoPrint: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .strict();
const patchSchema = printerSchema.omit({ outletId: true }).partial().strict();

type PrinterRow = Awaited<ReturnType<PrismaClient["printer"]["findUniqueOrThrow"]>>;

const view = (p: PrinterRow) => ({
  id: p.id, outletId: p.outletId, name: p.name, role: p.role, station: p.station, transport: p.transport, host: p.host, port: p.port, width: p.width,
  cashDrawer: p.cashDrawer, autoPrint: p.autoPrint, active: p.active, lastStatus: p.lastStatus, lastError: p.lastError, lastSeenAt: p.lastSeenAt,
  /** MOCK for SIMULATED printers: nothing reaches paper. */
  mode: p.transport === "SIMULATED" ? "MOCK" : "LIVE",
});

function validateTransport(d: { transport?: string; host?: string | null; port?: number }) {
  if (d.transport === "NETWORK_ESCPOS") {
    const problem = printerAddressProblem(d.host, d.port);
    if (problem) throw new ValidationError(problem, { fieldErrors: { host: [problem] } });
  }
}

async function loadPrinter(db: PrismaClient, ctx: AccessContext, printerId: string) {
  const p = await db.printer.findUnique({ where: { id: printerId } });
  if (!p || p.organizationId !== ctx.organizationId) throw new NotFoundError("Printer not found");
  assertOutletAccess(ctx, p.outletId);
  return p;
}

// ---------------- configuration ----------------

export async function listPrinters(db: PrismaClient, ctx: AccessContext, outletId: string) {
  await assertOutletInOrg(db, ctx, outletId); // another tenant's outlet is 404
  if (!can(ctx, "outlet.manage", outletId) && !can(ctx, "order.view", outletId) && !can(ctx, "kot.view", outletId)) throw new ForbiddenError("Missing permission to view printers");
  const rows = await db.printer.findMany({ where: { organizationId: ctx.organizationId, outletId }, orderBy: [{ role: "asc" }, { name: "asc" }] });
  return rows.map(view);
}

export async function createPrinter(ctx: AccessContext, input: z.input<typeof printerSchema>, db: PrismaClient = prisma) {
  const d = printerSchema.parse(input);
  await assertOutletInOrg(db, ctx, d.outletId);
  assertCan(ctx, "outlet.manage", d.outletId);
  validateTransport(d);
  return db.$transaction(async (tx) => {
    if (await tx.printer.findUnique({ where: { outletId_name: { outletId: d.outletId, name: d.name } } })) throw new ValidationError(`A printer named "${d.name}" already exists at this outlet`);
    const p = await tx.printer.create({ data: { organizationId: ctx.organizationId, ...d, station: d.station ?? null, host: d.transport === "NETWORK_ESCPOS" ? d.host : null } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Printer", entityId: p.id, outletId: p.outletId, after: view(p) });
    return view(p);
  });
}

export async function updatePrinter(ctx: AccessContext, printerId: string, input: z.input<typeof patchSchema>, db: PrismaClient = prisma) {
  const d = patchSchema.parse(input);
  const before = await loadPrinter(db, ctx, printerId);
  assertCan(ctx, "outlet.manage", before.outletId);
  const merged = { transport: d.transport ?? before.transport, host: d.host !== undefined ? d.host : before.host, port: d.port ?? before.port };
  validateTransport(merged);
  return db.$transaction(async (tx) => {
    const p = await tx.printer.update({ where: { id: printerId }, data: { ...d, host: merged.transport === "NETWORK_ESCPOS" ? merged.host : null } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Printer", entityId: p.id, outletId: p.outletId, before: view(before), after: view(p) });
    return view(p);
  });
}

/** Probe the printer (TCP connect; nothing printed) and record its status. */
export async function printerStatus(ctx: AccessContext, printerId: string, db: PrismaClient = prisma) {
  const p = await loadPrinter(db, ctx, printerId);
  if (!can(ctx, "outlet.manage", p.outletId) && !can(ctx, "order.view", p.outletId)) throw new ForbiddenError("Missing permission to check printers");
  const r = await probePrinter(p);
  const updated = await db.printer.update({ where: { id: p.id }, data: { lastStatus: r.online ? "ONLINE" : "OFFLINE", lastError: r.error ?? null, ...(r.online ? { lastSeenAt: new Date() } : {}) } });
  return { ...view(updated), simulated: r.simulated };
}

// ---------------- jobs ----------------

type JobInput = { printer: PrinterRow; kind: "RECEIPT" | "KOT" | "TEST" | "DRAWER"; dedupeKey: string; doc: Doc; sourceType?: string; sourceId?: string; reprintOfId?: string; reason?: string; cut?: boolean; kick?: boolean };

/**
 * Create the job (unique dedupeKey — a repeat returns the existing job) and
 * send it. The send happens outside any business transaction.
 */
async function runJob(db: PrismaClient, ctx: AccessContext, j: JobInput) {
  const content = plain(j.doc);
  let job = await db.printJob.findUnique({ where: { organizationId_dedupeKey: { organizationId: ctx.organizationId, dedupeKey: j.dedupeKey } } });
  if (job) return { job, duplicate: true };
  try {
    job = await db.printJob.create({
      data: { organizationId: ctx.organizationId, outletId: j.printer.outletId, printerId: j.printer.id, kind: j.kind, sourceType: j.sourceType, sourceId: j.sourceId, dedupeKey: j.dedupeKey, content, reprintOfId: j.reprintOfId, reason: j.reason, requestedById: ctx.userId === "system" ? null : ctx.userId },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      const winner = await db.printJob.findUnique({ where: { organizationId_dedupeKey: { organizationId: ctx.organizationId, dedupeKey: j.dedupeKey } } });
      if (winner) return { job: winner, duplicate: true };
    }
    throw e;
  }
  return { job: await send(db, ctx, job, j.printer, bytes(j.doc, { cut: j.cut, kickDrawer: j.kick })), duplicate: false };
}

async function send(db: PrismaClient, ctx: AccessContext, job: { id: string; attempts: number; kind: string; outletId: string; sourceType: string | null; sourceId: string | null; reprintOfId: string | null }, printer: PrinterRow, data: Buffer) {
  const r = await sendToPrinter(printer, data);
  const now = new Date();
  const status = r.ok ? (r.simulated ? "SIMULATED" : "PRINTED") : "FAILED";
  if (!r.ok) {
    inc("restora_integration_failures_total", { kind: job.kind === "DRAWER" ? "drawer" : "print" });
    log.warn("print job failed", { event: "print_failed", jobId: job.id, kind: job.kind, printerId: printer.id, attempt: job.attempts + 1, error: r.error });
  }
  const updated = await db.printJob.update({ where: { id: job.id }, data: { status, attempts: job.attempts + 1, lastError: r.ok ? null : r.error, printedAt: r.ok ? now : null } });
  await db.printer.update({ where: { id: printer.id }, data: r.ok ? { lastStatus: "ONLINE", lastError: null, lastSeenAt: now } : { lastStatus: "OFFLINE", lastError: r.error } });
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: job.kind === "DRAWER" ? "DRAWER_OPEN" : "PRINT", entityType: "PrintJob", entityId: job.id, outletId: job.outletId, after: { kind: job.kind, printer: printer.name, status, attempt: job.attempts + 1, source: job.sourceType ? `${job.sourceType}:${job.sourceId}` : null, reprintOf: job.reprintOfId, error: r.ok ? null : r.error } }));
  return updated;
}

const jobView = (j: { id: string; kind: string; status: string; attempts: number; lastError: string | null; printerId: string; sourceType: string | null; sourceId: string | null; reprintOfId: string | null; reason: string | null; createdAt: Date; printedAt: Date | null }) => ({
  id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, lastError: j.lastError, printerId: j.printerId, sourceType: j.sourceType, sourceId: j.sourceId, reprintOfId: j.reprintOfId, reason: j.reason, createdAt: j.createdAt, printedAt: j.printedAt,
});

const timeLabel = (d: Date | string, tz: string) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(d));

const reprintSchema = z.object({ printerId: z.string().min(1).optional(), reprint: z.boolean().default(false), reason: z.string().trim().min(3).max(200).optional() }).strict()
  .refine((d) => !d.reprint || Boolean(d.reason), { message: "A reprint needs a reason", path: ["reason"] });

/** Print the order's bill / receipt on the outlet's receipt printer (or a chosen one). */
export async function printReceipt(ctx: AccessContext, orderId: string, input: z.input<typeof reprintSchema> = {}, db: PrismaClient = prisma) {
  const d = reprintSchema.parse(input);
  const bill = await getOrderBill(db, ctx, orderId); // org / outlet / order.view checks
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { outletId: true } });
  const printer = d.printerId
    ? await loadPrinter(db, ctx, d.printerId)
    : await db.printer.findFirst({ where: { organizationId: ctx.organizationId, outletId: order.outletId, role: "RECEIPT", active: true }, orderBy: { createdAt: "asc" } });
  if (!printer || printer.outletId !== order.outletId) throw new ValidationError("No receipt printer is set up at this outlet");
  const first = `receipt:${orderId}:${printer.id}`;
  const original = await db.printJob.findUnique({ where: { organizationId_dedupeKey: { organizationId: ctx.organizationId, dedupeKey: first } } });
  const reprint = d.reprint && Boolean(original);
  const doc = receiptDoc(bill, printer.width, { reprint, timeLabel: timeLabel(bill.paidAt ?? bill.createdAt, bill.restaurant.timezone) });
  const r = await runJob(db, ctx, { printer, kind: "RECEIPT", dedupeKey: reprint ? `reprint:${randomUUID()}` : first, doc, sourceType: "Order", sourceId: orderId, reprintOfId: reprint ? original!.id : undefined, reason: reprint ? d.reason : undefined });
  return { ...jobView(r.job), duplicate: r.duplicate };
}

async function kotData(db: PrismaClient, ctx: AccessContext, kotId: string) {
  const kot = await db.kot.findUnique({ where: { id: kotId }, include: { items: { include: { orderItem: { select: { notes: true, modifiers: { select: { name: true } } } } } }, station: { select: { name: true } }, order: { select: { id: true, channel: true, table: { select: { code: true } } } } } });
  if (!kot || kot.organizationId !== ctx.organizationId) throw new NotFoundError("KOT not found");
  assertOutletAccess(ctx, kot.outletId);
  if (!can(ctx, "kot.view", kot.outletId) && !can(ctx, "order.view", kot.outletId)) throw new ForbiddenError("Missing permission to print kitchen tickets");
  const tz = (await db.outlet.findUniqueOrThrow({ where: { id: kot.outletId }, select: { timezone: true } })).timezone;
  return {
    kot,
    data: {
      number: kot.number, station: kot.station?.name ?? null, table: kot.order.table?.code ?? null, channel: kot.order.channel, orderRef: orderRef(kot.order.id), createdAt: timeLabel(kot.createdAt, tz),
      items: kot.items.filter((i) => i.status !== "CANCELLED").map((i) => ({ name: i.name, qty: i.qty.toString(), modifiers: i.orderItem?.modifiers.map((m) => m.name) ?? [], notes: i.orderItem?.notes ?? null })),
    },
  };
}

const kotPrinters = (db: PrismaClient, ctx: AccessContext, outletId: string, station: string | null, autoOnly: boolean) =>
  db.printer.findMany({ where: { organizationId: ctx.organizationId, outletId, role: "KOT", active: true, ...(autoOnly ? { autoPrint: true } : {}), OR: [{ station: null }, ...(station ? [{ station }] : [])] }, orderBy: { createdAt: "asc" } });

/** Print a KOT on the printers routed to its station (first print once per printer; reprints audited). */
export async function printKot(ctx: AccessContext, kotId: string, input: z.input<typeof reprintSchema> = {}, db: PrismaClient = prisma) {
  const d = reprintSchema.parse(input);
  const { kot, data } = await kotData(db, ctx, kotId);
  const printers = d.printerId ? [await loadPrinter(db, ctx, d.printerId)] : await kotPrinters(db, ctx, kot.outletId, data.station, false);
  if (!printers.length) throw new ValidationError(`No kitchen printer is set up for ${data.station ?? "this kitchen"}`);
  const jobs = [];
  for (const printer of printers) {
    if (printer.outletId !== kot.outletId) throw new ValidationError("Printer is at another outlet");
    const first = `kot:${kot.id}:${printer.id}`;
    const original = await db.printJob.findUnique({ where: { organizationId_dedupeKey: { organizationId: ctx.organizationId, dedupeKey: first } } });
    const reprint = d.reprint && Boolean(original);
    const r = await runJob(db, ctx, { printer, kind: "KOT", dedupeKey: reprint ? `reprint:${randomUUID()}` : first, doc: kotDoc(data, printer.width, { reprint }), sourceType: "Kot", sourceId: kot.id, reprintOfId: reprint ? original!.id : undefined, reason: reprint ? d.reason : undefined });
    jobs.push({ ...jobView(r.job), duplicate: r.duplicate });
  }
  return jobs;
}

/**
 * Auto-print every KOT of an order that has not been printed yet on the
 * auto-print kitchen printers. Called AFTER the order transaction committed;
 * never throws (a printer problem is a FAILED job, not an order error).
 */
export async function autoPrintKots(ctx: AccessContext, orderId: string, db: PrismaClient = prisma): Promise<number> {
  try {
    const kots = await db.kot.findMany({ where: { orderId, organizationId: ctx.organizationId, status: { not: "CANCELLED" } }, select: { id: true, outletId: true, station: { select: { name: true } } } });
    let printed = 0;
    for (const k of kots) {
      const printers = await kotPrinters(db, ctx, k.outletId, k.station?.name ?? null, true);
      for (const printer of printers) {
        const { data } = await kotData(db, ctx, k.id);
        const r = await runJob(db, ctx, { printer, kind: "KOT", dedupeKey: `kot:${k.id}:${printer.id}`, doc: kotDoc(data, printer.width, {}), sourceType: "Kot", sourceId: k.id });
        if (!r.duplicate) printed++;
      }
    }
    return printed;
  } catch (e) {
    log.error("auto KOT print failed", { event: "print_failed", orderId, error: e });
    return 0;
  }
}

/** Retry a FAILED job (bounded). Re-renders from the source so the paper shows current data. */
export async function retryPrintJob(ctx: AccessContext, jobId: string, db: PrismaClient = prisma) {
  const job = await db.printJob.findUnique({ where: { id: jobId }, include: { printer: true } });
  if (!job || job.organizationId !== ctx.organizationId) throw new NotFoundError("Print job not found");
  assertOutletAccess(ctx, job.outletId);
  if (!can(ctx, "outlet.manage", job.outletId) && !can(ctx, job.kind === "DRAWER" ? "payment.take" : "order.view", job.outletId)) throw new ForbiddenError("Missing permission to retry this print");
  if (job.status !== "FAILED") throw new ValidationError(`Only failed jobs can be retried (this one is ${job.status})`);
  if (job.attempts >= MAX_PRINT_ATTEMPTS) throw new ValidationError(`Gave up after ${MAX_PRINT_ATTEMPTS} attempts — check the printer, then print again`);
  let doc: Doc;
  if (job.kind === "RECEIPT" && job.sourceId) {
    const bill = await getOrderBill(db, ctx, job.sourceId);
    doc = receiptDoc(bill, job.printer.width, { reprint: Boolean(job.reprintOfId), timeLabel: timeLabel(bill.paidAt ?? bill.createdAt, bill.restaurant.timezone) });
  } else if (job.kind === "KOT" && job.sourceId) doc = kotDoc((await kotData(db, ctx, job.sourceId)).data, job.printer.width, { reprint: Boolean(job.reprintOfId) });
  else if (job.kind === "TEST") doc = testDoc(job.printer.name, job.printer.width, new Date().toISOString());
  else doc = [];
  const updated = await send(db, ctx, job, job.printer, bytes(doc, { cut: job.kind !== "DRAWER", kickDrawer: job.kind === "DRAWER" }));
  return jobView(updated);
}

export async function testPrint(ctx: AccessContext, printerId: string, db: PrismaClient = prisma) {
  const printer = await loadPrinter(db, ctx, printerId);
  assertCan(ctx, "outlet.manage", printer.outletId);
  const r = await runJob(db, ctx, { printer, kind: "TEST", dedupeKey: `test:${randomUUID()}`, doc: testDoc(printer.name, printer.width, new Date().toISOString()) });
  return jobView(r.job);
}

export async function listPrintJobs(db: PrismaClient, ctx: AccessContext, input: { outletId: string; status?: string; take?: number }) {
  const f = z.object({ outletId: z.string().min(1), status: z.enum(["QUEUED", "PRINTED", "SIMULATED", "FAILED"]).optional(), take: z.coerce.number().int().min(1).max(200).default(50) }).parse(input);
  await assertOutletInOrg(db, ctx, f.outletId);
  if (!can(ctx, "outlet.manage", f.outletId) && !can(ctx, "order.view", f.outletId)) throw new ForbiddenError("Missing permission to view print jobs");
  const rows = await db.printJob.findMany({ where: { organizationId: ctx.organizationId, outletId: f.outletId, ...(f.status ? { status: f.status } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.take });
  return rows.map(jobView);
}

// ---------------- cash drawer ----------------

/**
 * Open (kick) the cash drawer wired to the outlet's drawer printer. The drawer
 * movement / payment it accompanies is already committed — a hardware failure
 * is recorded on the job and returned, never rolled into the money records.
 */
export async function kickCashDrawer(ctx: AccessContext, input: { outletId: string; reason: string }, db: PrismaClient = prisma) {
  const d = z.object({ outletId: z.string().min(1), reason: z.string().trim().min(3).max(120) }).parse(input);
  await assertOutletInOrg(db, ctx, d.outletId);
  assertCan(ctx, "payment.take", d.outletId);
  const printer = await db.printer.findFirst({ where: { organizationId: ctx.organizationId, outletId: d.outletId, cashDrawer: true, active: true }, orderBy: { createdAt: "asc" } });
  if (!printer) return { kicked: false as const, reason: "No cash drawer is connected at this outlet" };
  const r = await runJob(db, ctx, { printer, kind: "DRAWER", dedupeKey: `drawer:${randomUUID()}`, doc: [], cut: false, kick: true, reason: d.reason });
  return { kicked: r.job.status === "PRINTED" || r.job.status === "SIMULATED", simulated: r.job.status === "SIMULATED", job: jobView(r.job) };
}

/** Drawer kick after a committed cash event. Never throws; no drawer configured = no-op. */
export async function kickDrawerAfter(ctx: AccessContext, outletId: string, reason: string, db: PrismaClient = prisma) {
  try {
    if (!can(ctx, "payment.take", outletId)) return;
    await kickCashDrawer(ctx, { outletId, reason }, db);
  } catch (e) {
    log.error("cash drawer kick failed", { event: "drawer_failed", outletId, error: e });
  }
}
