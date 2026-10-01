import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { outletScope, type AccessContext } from "../../src/server/db/scope";

// A fresh client bound to the test DB (DATABASE_URL is injected by vitest).
const db = new PrismaClient();

// Unique suffix so repeated runs never collide on unique constraints.
const RUN = Date.now().toString(36);

let orgId: string;
let outletA: string;
let outletB: string;
let unitKg: string;
let material: string;

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `Org ${RUN}` } });
  orgId = org.id;
  const a = await db.outlet.create({ data: { organizationId: orgId, code: `A${RUN}`, name: "Outlet A" } });
  const b = await db.outlet.create({ data: { organizationId: orgId, code: `B${RUN}`, name: "Outlet B" } });
  outletA = a.id;
  outletB = b.id;
  const unit = await db.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "Kilogram", kind: "WEIGHT" } });
  unitKg = unit.id;
  const mat = await db.material.create({
    data: { organizationId: orgId, sku: `RICE-${RUN}`, name: "Rice", baseUnitId: unitKg },
  });
  material = mat.id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Inventory ledger (append-only, derived balance)", () => {
  it("derives stock as the signed sum of ledger rows", async () => {
    await db.inventoryLedger.createMany({
      data: [
        { organizationId: orgId, outletId: outletA, materialId: material, unitId: unitKg, txnType: "OPENING_BALANCE", qty: new Prisma.Decimal(100), rate: 50, amount: 5000, sourceRef: `open-${RUN}` },
        { organizationId: orgId, outletId: outletA, materialId: material, unitId: unitKg, txnType: "PURCHASE_RECEIPT", qty: new Prisma.Decimal(50), rate: 52, amount: 2600, sourceRef: `grn-${RUN}` },
        { organizationId: orgId, outletId: outletA, materialId: material, unitId: unitKg, txnType: "SALE_CONSUMPTION", qty: new Prisma.Decimal(-30), rate: 51, amount: -1530, sourceRef: `sale-${RUN}` },
        { organizationId: orgId, outletId: outletA, materialId: material, unitId: unitKg, txnType: "WASTAGE", qty: new Prisma.Decimal(-5), rate: 51, amount: -255, sourceRef: `waste-${RUN}` },
      ],
    });

    const agg = await db.inventoryLedger.aggregate({
      where: { organizationId: orgId, outletId: outletA, materialId: material },
      _sum: { qty: true },
    });
    // 100 + 50 - 30 - 5 = 115
    expect(Number(agg._sum.qty)).toBe(115);
  });

  it("rejects a duplicate movement via the unique sourceRef (idempotency)", async () => {
    const dup = { organizationId: orgId, outletId: outletA, materialId: material, unitId: unitKg, txnType: "SALE_CONSUMPTION", qty: new Prisma.Decimal(-10), sourceRef: `dup-${RUN}` };
    await db.inventoryLedger.create({ data: dup });
    await expect(db.inventoryLedger.create({ data: dup })).rejects.toMatchObject({ code: "P2002" });

    // Balance is unaffected by the rejected duplicate.
    const count = await db.inventoryLedger.count({ where: { sourceRef: `dup-${RUN}` } });
    expect(count).toBe(1);
  });

  it("supports corrections as new append-only rows (no edit/delete)", async () => {
    const wrong = await db.inventoryLedger.create({
      data: { organizationId: orgId, outletId: outletA, materialId: material, txnType: "OTHER_ADJUSTMENT", qty: new Prisma.Decimal(999), sourceRef: `wrong-${RUN}` },
    });
    const correction = await db.inventoryLedger.create({
      data: { organizationId: orgId, outletId: outletA, materialId: material, txnType: "OTHER_ADJUSTMENT", qty: new Prisma.Decimal(-999), correctionOfId: wrong.id, sourceRef: `fix-${RUN}` },
    });
    expect(correction.correctionOfId).toBe(wrong.id);
    // Original row still exists — history preserved.
    const original = await db.inventoryLedger.findUnique({ where: { id: wrong.id } });
    expect(original).not.toBeNull();
  });
});

describe("Order idempotency", () => {
  it("prevents duplicate POS/webhook orders via (outletId, source, externalRef)", async () => {
    const data = { organizationId: orgId, outletId: outletA, source: "PETPOOJA", externalRef: `PP-${RUN}`, channel: "AGGREGATOR" as const };
    await db.order.create({ data });
    await expect(db.order.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same externalRef in a different outlet", async () => {
    const ref = `SHARED-${RUN}`;
    await db.order.create({ data: { organizationId: orgId, outletId: outletA, source: "POS", externalRef: ref } });
    const second = await db.order.create({ data: { organizationId: orgId, outletId: outletB, source: "POS", externalRef: ref } });
    expect(second.id).toBeTruthy();
  });
});

describe("Webhook event idempotency", () => {
  it("prevents processing the same provider event twice", async () => {
    const evt = { provider: "petpooja", eventId: `E-${RUN}`, payload: "{}" };
    await db.webhookEvent.create({ data: evt });
    await expect(db.webhookEvent.create({ data: evt })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("Outlet isolation (scope helper)", () => {
  it("outletScope restricts a non-org-wide actor to their outlets", async () => {
    const ctx: AccessContext = { userId: "u1", organizationId: orgId, outletIds: [outletA], roles: ["STORE"], outletRoles: { [outletA]: ["STORE"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
    const rows = await db.inventoryLedger.findMany({ where: { ...outletScope(ctx), materialId: material } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.outletId === outletA)).toBe(true);

    // Actor with access only to outlet B sees none of outlet A's ledger.
    const ctxB: AccessContext = { userId: "u2", organizationId: orgId, outletIds: [outletB], roles: ["STORE"], outletRoles: { [outletB]: ["STORE"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
    const none = await db.inventoryLedger.findMany({ where: { ...outletScope(ctxB), materialId: material } });
    expect(none.length).toBe(0);
  });
});
