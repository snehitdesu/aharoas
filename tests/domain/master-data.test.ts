/**
 * Master-data administration + procurement/stock document reads.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  createUnit, updateUnit, createUnitConversion, createMaterial, updateMaterial, listMaterials,
  createVendor, updateVendor, listVendors, linkVendorMaterial, createOutlet, updateOutlet, listOutlets,
  createFloor, createTable, updateTable, setTableStatus, rotateTableQr, listTables,
} from "@/server/services/masterData";
import { createPurchaseOrder, createGRN, postGRN, createPurchaseBill, payVendor } from "@/server/services/procurement";
import { createTransfer, createStockCount } from "@/server/services/stockOps";
import { createReservation } from "@/server/services/reservations";
import { createOrder } from "@/server/services/orders";
import { listPurchaseOrders, getPurchaseOrder, listGRNs, listPurchaseBills, listVendorPayments, listTransfers, getTransfer, listStockCounts } from "@/server/services/documentQueries";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, outletC: string;
let owner: AccessContext, admin: AccessContext, mgrA: AccessContext, mgrB: AccessContext, mgrC: AccessContext, storeA: AccessContext, captainA: AccessContext, org2: AccessContext;
let kg: string, g: string, pc: string, vendorId: string, riceId: string;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const orgWide = (role: string): AccessContext => ({ userId: role.toLowerCase(), organizationId: orgId, outletIds: [outletA, outletB, outletC], roles: [role], outletRoles: {}, orgRoles: [role], isOrgWide: true, isSuperAdmin: false });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Master Org ${RUN}` } })).id;
  const mk = async (c: string) => (await prisma.outlet.create({ data: { organizationId: orgId, code: `${c}${RUN}`, name: c } })).id;
  outletA = await mk("MA"); outletB = await mk("MB"); outletC = await mk("MC");
  owner = orgWide("OWNER"); admin = orgWide("ADMIN");
  mgrA = member("MANAGER", outletA); mgrB = member("MANAGER", outletB); mgrC = member("MANAGER", outletC);
  storeA = member("STORE", outletA); captainA = member("CAPTAIN", outletA);
  org2 = systemContext((await prisma.organization.create({ data: { name: `Master Org2 ${RUN}` } })).id, []);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("units and conversions", () => {
  it("org-wide only; codes unique; in-use units protected", async () => {
    await expect(createUnit(mgrA, { code: "kg", name: "Kilogram", kind: "WEIGHT" })).rejects.toBeInstanceOf(ForbiddenError);
    kg = (await createUnit(admin, { code: `kg${RUN}`, name: "Kilogram", kind: "WEIGHT" })).id;
    g = (await createUnit(admin, { code: `g${RUN}`, name: "Gram", kind: "WEIGHT" })).id;
    pc = (await createUnit(admin, { code: `pc${RUN}`, name: "Piece", kind: "COUNT" })).id;
    await expect(createUnit(admin, { code: `kg${RUN}`, name: "Dup", kind: "WEIGHT" })).rejects.toBeInstanceOf(ValidationError);
    await createUnitConversion(admin, { fromUnitId: kg, toUnitId: g, factor: 1000 });
    await expect(createUnitConversion(admin, { fromUnitId: pc, toUnitId: g, factor: 50 })).rejects.toBeInstanceOf(ValidationError); // cross-kind global
    await expect(updateUnit(admin, kg, { kind: "VOLUME" })).rejects.toBeInstanceOf(ValidationError); // in use by a conversion
    expect((await updateUnit(admin, kg, { name: "Kilo" })).name).toBe("Kilo");
  });
});

describe("materials", () => {
  it("create, validate, protect the base unit once stock moved, deactivate", async () => {
    riceId = (await createMaterial(admin, { sku: `RICE-${RUN}`, name: "Rice", baseUnitId: kg, reorderLevel: 10 })).id;
    await expect(createMaterial(admin, { sku: `RICE-${RUN}`, name: "Dup", baseUnitId: kg })).rejects.toBeInstanceOf(ValidationError);
    await expect(createMaterial(mgrA, { sku: `X-${RUN}`, name: "X", baseUnitId: kg })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createMaterial(admin, { sku: `Y-${RUN}`, name: "Y", baseUnitId: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    const egg = await createMaterial(admin, { sku: `EGG-${RUN}`, name: "Egg", baseUnitId: kg });
    expect((await updateMaterial(admin, egg.id, { baseUnitId: pc })).baseUnitId).toBe(pc); // no stock yet
    await createUnitConversion(admin, { fromUnitId: pc, toUnitId: g, factor: 50, materialId: egg.id }); // material-specific cross-kind is fine

    vendorId = (await createVendor(admin, { name: `Grain Co ${RUN}`, gstin: "29ABCDE1234F1Z5", bankAccount: "123456789012", bankIfsc: "HDFC0001234" })).id;
    const grn = await createGRN(owner, { outletId: outletA, vendorId, lines: [{ materialId: riceId, qty: 10, rate: 50 }] });
    await postGRN(owner, grn.id);
    await expect(updateMaterial(admin, riceId, { baseUnitId: g })).rejects.toThrow(/Base unit cannot change/);
    await expect(updateUnit(admin, kg, { active: false })).rejects.toBeInstanceOf(ValidationError); // base unit of an active material
    await updateMaterial(admin, egg.id, { active: false });
    const { items } = await listMaterials(prisma, storeA, { active: true });
    expect(items.some((m) => m.id === egg.id)).toBe(false);
    expect(await prisma.auditLog.count({ where: { entityType: "Material", entityId: riceId } })).toBeGreaterThanOrEqual(1);
  });
});

describe("vendors", () => {
  it("validation, bank-detail masking, masked bank audit, preferred vendor", async () => {
    await expect(createVendor(admin, { name: "Bad", gstin: "short" })).rejects.toBeInstanceOf(ZodError);
    await expect(createVendor(mgrA, { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError); // MANAGER has vendor.manage but only at an outlet
    const masked = (await listVendors(prisma, storeA, { search: "Grain" })).items[0];
    expect(masked.bankAccount).toBe("••••9012");
    expect((await listVendors(prisma, admin, { search: "Grain" })).items[0].bankAccount).toBe("123456789012");
    await updateVendor(admin, vendorId, { bankAccount: "999988887777" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Vendor", entityId: vendorId, action: "UPDATE" } });
    expect(audit.after).toContain("••••7777");
    expect(audit.after).not.toContain("999988887777");

    const v2 = (await createVendor(admin, { name: `Second ${RUN}` })).id;
    await linkVendorMaterial(admin, { vendorId, materialId: riceId, preferred: true, lastRate: 50 });
    await linkVendorMaterial(admin, { vendorId: v2, materialId: riceId, preferred: true });
    const links = await prisma.vendorMaterial.findMany({ where: { materialId: riceId } });
    expect(links.filter((l) => l.preferred).map((l) => l.vendorId)).toEqual([v2]);
    expect((await prisma.material.findUniqueOrThrow({ where: { id: riceId } })).preferredVendorId).toBe(v2);
  });
});

describe("outlets", () => {
  it("create needs org.manage; managers edit contact details only; timezones validated", async () => {
    await expect(createOutlet(admin, { code: `NEW${RUN}`, name: "New" })).rejects.toBeInstanceOf(ForbiddenError); // ADMIN lacks org.manage
    const created = await createOutlet(owner, { code: `NEW${RUN}`, name: "New", timezone: "Asia/Dubai" });
    expect(created.timezone).toBe("Asia/Dubai");
    await expect(createOutlet(owner, { code: `NEW${RUN}`, name: "Dup" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createOutlet(owner, { code: `TZ${RUN}`, name: "Bad", timezone: "Mars/Base" })).rejects.toBeInstanceOf(ZodError);
    expect((await updateOutlet(mgrA, outletA, { phone: "080-1234" })).phone).toBe("080-1234");
    await expect(updateOutlet(mgrA, outletA, { timezone: "UTC" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOutlet(mgrA, outletB, { phone: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await updateOutlet(admin, outletA, { timezone: "Asia/Kolkata" })).timezone).toBe("Asia/Kolkata");
    await expect(updateOutlet(org2, outletA, { phone: "1" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listOutlets(prisma, mgrA)).map((o) => o.id)).toEqual([outletA]);
  });
});

describe("floors and tables", () => {
  it("outlet managers manage their own tables; status and capacity are protected", async () => {
    const floor = await createFloor(mgrA, { outletId: outletA, name: "Ground" });
    const t = await createTable(mgrA, { outletId: outletA, code: "T1", capacity: 6, floorId: floor.id });
    await expect(createTable(mgrA, { outletId: outletA, code: "T1" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTable(mgrA, { outletId: outletB, code: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    const floorB = await createFloor(mgrB, { outletId: outletB, name: "Terrace" });
    await expect(updateTable(mgrA, t.id, { floorId: floorB.id })).rejects.toBeInstanceOf(ValidationError);

    await createReservation(mgrA, { outletId: outletA, tableId: t.id, partySize: 5, reservedAt: new Date(Date.now() + 86400_000) });
    await expect(updateTable(mgrA, t.id, { capacity: 4 })).rejects.toBeInstanceOf(ValidationError);

    await createOrder(mgrA, { outletId: outletA, tableId: t.id });
    await expect(setTableStatus(captainA, t.id, "AVAILABLE")).rejects.toBeInstanceOf(ValidationError); // running order
    expect((await setTableStatus(captainA, t.id, "CLEANING")).status).toBe("CLEANING");
    await expect(setTableStatus(member("KITCHEN", outletA), t.id, "AVAILABLE")).rejects.toBeInstanceOf(ForbiddenError);

    const q1 = (await rotateTableQr(mgrA, t.id)).qrToken;
    const q2 = (await rotateTableQr(mgrA, t.id)).qrToken;
    expect(q1).toMatch(/^[\w-]{20,}$/);
    expect(q2).not.toBe(q1);
    await expect(rotateTableQr(captainA, t.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listTables(prisma, captainA, outletA)).map((x) => x.code)).toEqual(["T1"]);
    await expect(listTables(prisma, captainA, outletB)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("document reads", () => {
  it("procurement documents are outlet- and org-scoped and paginated", async () => {
    for (const outletId of [outletA, outletB]) {
      await createPurchaseOrder(owner, { outletId, vendorId, lines: [{ materialId: riceId, qty: 5, rate: 50 }] });
      await createPurchaseOrder(owner, { outletId, vendorId, lines: [{ materialId: riceId, qty: 6, rate: 50 }] });
    }
    const bOnly = await listPurchaseOrders(prisma, mgrB);
    expect(bOnly.items.every((p) => p.outletId === outletB)).toBe(true);
    expect(bOnly.items).toHaveLength(2);
    await expect(listPurchaseOrders(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    const aPo = (await listPurchaseOrders(prisma, mgrA, { take: 1 }));
    expect(aPo.items).toHaveLength(1);
    expect(aPo.nextCursor).not.toBeNull();
    await expect(getPurchaseOrder(prisma, mgrB, aPo.items[0].id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getPurchaseOrder(prisma, org2, aPo.items[0].id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getPurchaseOrder(prisma, mgrA, aPo.items[0].id)).lines).toHaveLength(1);
    expect((await listPurchaseOrders(prisma, mgrA, { status: "DRAFT" })).items.length).toBe(2);

    expect((await listGRNs(prisma, mgrA, { status: "POSTED" })).items.length).toBeGreaterThanOrEqual(1);
    const bill = await createPurchaseBill(owner, { outletId: outletA, vendorId, lines: [{ materialId: riceId, qty: 1, rate: 100 }] });
    await payVendor(owner, { outletId: outletA, vendorId, billId: bill.id, amount: 100 });
    expect((await listPurchaseBills(prisma, mgrA, { status: "PAID" })).items.map((b) => b.id)).toContain(bill.id);
    expect((await listVendorPayments(prisma, mgrA)).items.length).toBe(1);
    await expect(listVendorPayments(prisma, storeA)).rejects.toBeInstanceOf(ForbiddenError); // no finance.view
  });

  it("transfers are visible at both ends only; stock counts are listed per outlet", async () => {
    const t = await createTransfer(owner, { fromOutletId: outletA, toOutletId: outletB, lines: [{ materialId: riceId, requestedQty: 1 }] });
    expect((await listTransfers(prisma, mgrB)).items.map((x) => x.id)).toContain(t.id);
    expect((await getTransfer(prisma, mgrA, t.id)).lines).toHaveLength(1);
    await expect(getTransfer(prisma, mgrC, t.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listTransfers(prisma, mgrC)).items).toHaveLength(0);
    await createStockCount(owner, { outletId: outletA });
    expect((await listStockCounts(prisma, mgrA)).items).toHaveLength(1);
    expect((await listStockCounts(prisma, mgrB)).items).toHaveLength(0);
  });
});
