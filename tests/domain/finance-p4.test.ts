/**
 * Phase 4 — finance, against the real services:
 *  - GST primitives (GSTIN checksum, financial year, CGST/SGST split, invoice number format)
 *  - tax AFTER discount (apportionment, per-rate rounding)
 *  - invoices: gapless sequential numbers per outlet/FY, unique, concurrent settlements,
 *    CGST/SGST vs unregistered seller, B2B buyer GSTIN, credit notes on refunds,
 *    external-platform orders not re-invoiced
 *  - expenses: categories, idempotency, 2-decimal rule, future dates, void (+ petty cash), totals
 *  - petty cash + drawer pay-in / pay-out idempotency, expected cash, variance frozen
 *  - vendor payables: partial, overpayment, duplicate, concurrent, reversal, cancelled bills,
 *    advances, aging, statement
 *  - cash + online payment reconciliation, finance reports, RBAC, tenant / outlet isolation
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { validateGstin, gstinCheckChar, fiscalYearOf, splitTax, formatInvoiceNumber, supplyTypeOf } from "@/domain/gst";
import { calculateOrderTotals, placeOrder, applyDiscount } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { createMenuItem } from "@/server/services/menu";
import { issueInvoice, setOrderBuyer, getOrderInvoices, listInvoices } from "@/server/services/invoicing";
import { getOrderBill } from "@/server/services/bill";
import { createExpense, voidExpense, listExpenses, expensesByCategory, createExpenseCategory, setExpenseCategoryActive, listExpenseCategories, recordPettyCash, pettyCashBalance, openCashDrawer, closeCashDrawer, recordDrawerMovement, saveDailyReconciliation, dailyClosing, computePnL } from "@/server/services/finance";
import { createPurchaseBill, payVendor, cancelPurchaseBill } from "@/server/services/procurement";
import { vendorAging, vendorStatement, reverseVendorPayment } from "@/server/services/vendorFinance";
import { runPaymentReconciliation } from "@/server/services/reconciliation";
import { updateOutlet } from "@/server/services/masterData";
import { processPOSOrder } from "@/server/services/pos";
import { getReport } from "@/server/services/reports";
import { MockPaymentProvider } from "@/integrations/payment";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
const GSTIN_TS = "36ABCDE1234F1Z1"; // Telangana, checksum-valid
const BUYER_KA = "29ABCDE1234F1ZW"; // Karnataka
let orgId: string, A: string, B: string, U: string, foreignOrg: string;
let sys: AccessContext, manager: AccessContext, cashier: AccessContext, kitchen: AccessContext, owner: AccessContext, managerB: AccessContext, foreign: AccessContext;
let dosa: string, cola: string, vendor: string, rice: string;

const role = (id: string, outlet: string | null, r: string): AccessContext =>
  outlet
    ? { userId: `${id}-${RUN}`, organizationId: orgId, outletIds: [outlet], roles: [r], outletRoles: { [outlet]: [r] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false }
    : { userId: `${id}-${RUN}`, organizationId: orgId, outletIds: [A, B, U], roles: [r], outletRoles: {}, orgRoles: [r], isOrgWide: true, isSuperAdmin: false };
let n = 0;
const key = (p = "k") => `${p}-${RUN}-${++n}-abc`;

async function paidOrder(outletId: string, items: Array<{ menuItemId: string; qty: number }>, discount = 0, method: "CASH" | "UPI" = "CASH") {
  const o = await placeOrder(sys, { outletId, channel: "TAKEAWAY", submit: true, items });
  if (discount) await applyDiscount(sys, o.id, discount);
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  const p = await createPayment(sys, o.id, { method, amount: num(fresh.total) });
  await verifyPayment(sys, p.id);
  return { orderId: o.id, paymentId: p.id, total: num(fresh.total) };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Fin Org ${RUN}`, legalName: "Fin Foods Pvt Ltd" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `FA${RUN}`, name: "Fin A", address: "1 Road, Hyderabad", gstin: GSTIN_TS, invoiceSeries: "FINA" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `FB${RUN}`, name: "Fin B", gstin: GSTIN_TS, invoiceSeries: "FINB" } })).id;
  U = (await prisma.outlet.create({ data: { organizationId: orgId, code: `FU${RUN}`, name: "Fin Unregistered", invoiceSeries: "FINU" } })).id; // no GSTIN anywhere
  await prisma.organization.update({ where: { id: orgId }, data: { gstin: null } });
  sys = systemContext(orgId, [A, B, U]);
  manager = role("mgr", A, "MANAGER");
  managerB = role("mgrb", B, "MANAGER");
  cashier = role("cash", A, "CASHIER");
  kitchen = role("kit", A, "KITCHEN");
  owner = role("own", null, "OWNER");
  foreignOrg = (await prisma.organization.create({ data: { name: `Fin Foreign ${RUN}` } })).id;
  const fo = (await prisma.outlet.create({ data: { organizationId: foreignOrg, code: `FF${RUN}`, name: "F" } })).id;
  foreign = systemContext(foreignOrg, [fo]);
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 100, taxPct: 5 })).id;
  cola = (await createMenuItem(sys, { name: `Cola ${RUN}`, price: 99.99, taxPct: 18 })).id;
  vendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Veg Co ${RUN}` } })).id;
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  rice = (await prisma.material.create({ data: { organizationId: orgId, sku: `R-${RUN}`, name: "Rice", baseUnitId: kg } })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

// ------------------------------------------------------------------
describe("GST primitives", () => {
  it("validates GSTIN format, state code and checksum", () => {
    expect(validateGstin(GSTIN_TS)).toEqual({ valid: true, gstin: GSTIN_TS, stateCode: "36", pan: "ABCDE1234F" });
    expect(validateGstin(" 27aapfu0939f1zv ")).toMatchObject({ valid: true, gstin: "27AAPFU0939F1ZV", stateCode: "27" });
    expect(validateGstin("36ABCDE1234F1Z5")).toMatchObject({ valid: false, reason: expect.stringMatching(/check character/) }); // the old demo value
    expect(validateGstin("99ABCDE1234F1Z" + gstinCheckChar("99ABCDE1234F1Z"))).toMatchObject({ valid: false, reason: expect.stringMatching(/state code/) });
    for (const bad of ["", "SHORT", "36ABCDE1234F1X1", "3GABCDE1234F1Z1", "36ABCDE1234F0Z1"]) expect(validateGstin(bad).valid).toBe(false);
  });

  it("financial year, supply type, CGST/SGST split with the odd paisa on SGST, invoice numbers ≤ 16 chars", () => {
    expect([fiscalYearOf("2026-03-31"), fiscalYearOf("2026-04-01"), fiscalYearOf("2099-12-31")]).toEqual(["2025-26", "2026-27", "2099-00"]);
    expect([supplyTypeOf("36", "36"), supplyTypeOf("36", "29"), supplyTypeOf(null, "36")]).toEqual(["INTRA", "INTER", "UNREGISTERED"]);
    expect(Object.values(splitTax("4.99", "INTRA")).map(num)).toEqual([2.5, 2.49, 0]); // half rounded on CGST, rest on SGST: sums exactly
    expect(Object.values(splitTax("4.99", "INTER")).map(num)).toEqual([0, 0, 4.99]);
    expect(Object.values(splitTax("4.99", "UNREGISTERED")).map(num)).toEqual([0, 0, 0]);
    expect(formatInvoiceNumber("HYD", "2026-27", 7)).toBe("HYD/2627/00007");
    // A series ending in "C" must not make credit notes collide with invoices.
    expect(formatInvoiceNumber("HYDC", "2026-27", 1)).toBe("HYDC/2627/00001");
    expect(formatInvoiceNumber("HYDC", "2026-27", 1, "CREDIT_NOTE")).toBe("HYDC/2627C/00001");
    expect(formatInvoiceNumber("HYDC", "2026-27", 99999, "CREDIT_NOTE").length).toBe(16);
    expect(formatInvoiceNumber("FINA", "2026-27", 99999).length).toBeLessThanOrEqual(16);
  });
});

// ------------------------------------------------------------------
describe("tax after discount", () => {
  it("apportions the discount by line value and taxes the discounted value per rate", () => {
    const t = calculateOrderTotals([{ qty: 3, unitPrice: 99.99, taxPct: 18 }, { qty: 1, unitPrice: 90, taxPct: 5 }], 10);
    expect(t.byRate.map((r) => [num(r.ratePct), num(r.taxable), num(r.tax)])).toEqual([[5, 87.69, 4.38], [18, 292.28, 52.61]]);
    expect([num(t.subtotal), num(t.discount), num(t.tax), num(t.total)]).toEqual([389.97, 10, 56.99, 436.96]);
    // No discount: identical to taxing each line's net.
    expect(num(calculateOrderTotals([{ qty: 2, unitPrice: 100, taxPct: 5 }]).tax)).toBe(10);
    // Shares add up to the discount exactly (three equal lines, ₹10 -> 3.33 + 3.33 + 3.34).
    const three = calculateOrderTotals([1, 2, 3].map(() => ({ qty: 1, unitPrice: 10, taxPct: 0 })), 10);
    expect(num(three.byRate[0].taxable)).toBe(20);
    expect(() => calculateOrderTotals([{ qty: 1, unitPrice: 10, taxPct: 5 }], 11)).toThrow(/exceeds subtotal/);
  });

  it("a discounted order's persisted tax and total follow the rule; sub-paisa amounts are refused", async () => {
    const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", items: [{ menuItemId: dosa, qty: 2 }] });
    await applyDiscount(sys, o.id, 20);
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([num(fresh.subtotal), num(fresh.discount), num(fresh.tax), num(fresh.total)]).toEqual([200, 20, 9, 189]);
    await expect(applyDiscount(sys, o.id, 10.005)).rejects.toBeInstanceOf(ZodError);
    await expect(createPayment(sys, o.id, { method: "CASH", amount: 100.001 })).rejects.toBeInstanceOf(ZodError);
  });
});

// ------------------------------------------------------------------
describe("invoices and credit notes", () => {
  it("a paid order gets the next gapless number of its outlet and financial year, with CGST + SGST", async () => {
    const a = await paidOrder(A, [{ menuItemId: dosa, qty: 2 }, { menuItemId: cola, qty: 1 }], 20);
    const [inv] = await getOrderInvoices(prisma, a.orderId);
    expect(inv).toMatchObject({ kind: "INVOICE", seq: 1, sellerGstin: GSTIN_TS, sellerStateCode: "36", placeOfSupply: "36", supplyType: "INTRA", sellerName: "Fin Foods Pvt Ltd" });
    expect(inv.number).toMatch(/^FINA\/\d{4}\/00001$/);
    expect(inv.number.length).toBeLessThanOrEqual(16);
    // Lines: 200 @5% (largest) and 99.99 @18%; ₹20 discount shared by value: cola 6.67, dosa the remaining 13.33.
    // Taxable 186.67 @5% = 9.33 -> CGST 4.67 + SGST 4.66 ; 93.32 @18% = 16.80 -> 8.40 + 8.40.
    expect(inv.lines.map((l) => [num(l.ratePct), num(l.taxableValue), num(l.cgst), num(l.sgst)])).toEqual([[5, 186.67, 4.67, 4.66], [18, 93.32, 8.4, 8.4]]);
    expect(num(inv.cgst) + num(inv.sgst)).toBeCloseTo(num(inv.totalTax), 2);
    expect(num(inv.total)).toBe(a.total);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } })).invoiceNo).toBe(inv.number);
    // The bill shows the invoice and its GST split but never calls itself a tax invoice.
    const bill = await getOrderBill(prisma, manager, a.orderId);
    expect(bill.invoice).toMatchObject({ number: inv.number, sellerGstin: GSTIN_TS, supplyType: "INTRA" });
    expect(bill.billNo).toBe(inv.number);
    // Issuing again is a no-op (one invoice per order).
    expect((await issueInvoice(manager, a.orderId)).id).toBe(inv.id);
    expect(await prisma.taxInvoice.count({ where: { orderId: a.orderId, kind: "INVOICE" } })).toBe(1);
    // Next order at A: 00002; outlet B has its own series.
    const b = await paidOrder(A, [{ menuItemId: dosa, qty: 1 }]);
    expect((await getOrderInvoices(prisma, b.orderId))[0].seq).toBe(2);
    const c = await paidOrder(B, [{ menuItemId: dosa, qty: 1 }]);
    expect((await getOrderInvoices(prisma, c.orderId))[0].number).toMatch(/^FINB\/\d{4}\/00001$/);
  });

  it("concurrent settlements never share or skip a number; a duplicate number is refused by the database", async () => {
    const orders = await Promise.all([1, 2, 3, 4].map(() => placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 1 }] })));
    await Promise.all(orders.map(async (o) => {
      const p = await createPayment(sys, o.id, { method: "UPI", amount: 105 });
      await verifyPayment(sys, p.id);
    }));
    const seqs = (await prisma.taxInvoice.findMany({ where: { outletId: A, kind: "INVOICE" }, select: { seq: true }, orderBy: { seq: "asc" } })).map((i) => i.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 1..n, no gap, no duplicate
    const any = await prisma.taxInvoice.findFirstOrThrow({ where: { outletId: A } });
    await expect(prisma.taxInvoice.create({ data: { ...any, id: undefined, sourceKey: `dup-${RUN}`, orderId: any.orderId, createdAt: undefined } as never })).rejects.toMatchObject({ code: "P2002" });
  });

  it("an outlet without a valid GSTIN issues numbered invoices with no GST split (UNREGISTERED)", async () => {
    const u = await paidOrder(U, [{ menuItemId: dosa, qty: 1 }]);
    const [inv] = await getOrderInvoices(prisma, u.orderId);
    expect(inv).toMatchObject({ supplyType: "UNREGISTERED", sellerGstin: null });
    expect([num(inv.cgst), num(inv.sgst), num(inv.igst)]).toEqual([0, 0, 0]);
  });

  it("B2B: the buyer's GSTIN is validated and recorded before payment; never edited after", async () => {
    const o = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 1 }] });
    await expect(setOrderBuyer(cashier, o.id, { gstin: "29ABCDE1234F1Z5" })).rejects.toThrow(/Buyer GSTIN/);
    await expect(setOrderBuyer(kitchen, o.id, { gstin: BUYER_KA })).rejects.toBeInstanceOf(ForbiddenError);
    await setOrderBuyer(cashier, o.id, { gstin: BUYER_KA.toLowerCase(), name: "Acme Pvt Ltd" });
    const p = await createPayment(sys, o.id, { method: "CARD", amount: 105 });
    await verifyPayment(sys, p.id);
    const [inv] = await getOrderInvoices(prisma, o.id);
    // Restaurant service: the place of supply is the restaurant, so a buyer from another state is still CGST + SGST.
    expect(inv).toMatchObject({ buyerGstin: BUYER_KA, buyerName: "Acme Pvt Ltd", supplyType: "INTRA", placeOfSupply: "36" });
    await expect(setOrderBuyer(cashier, o.id, { gstin: null })).rejects.toThrow(/before the order is paid/);
  });

  it("each refund issues a proportional credit note in its own series; external-platform orders are not invoiced", async () => {
    const o = await paidOrder(A, [{ menuItemId: dosa, qty: 2 }], 0, "UPI"); // 210 = 200 + 10 tax
    const [inv] = await getOrderInvoices(prisma, o.orderId);
    await refundPayment(sys, o.paymentId, { amount: 105, reason: "Half the order was cold" });
    let docs = await getOrderInvoices(prisma, o.orderId);
    const cn = docs.find((d) => d.kind === "CREDIT_NOTE")!;
    expect(cn.number).toMatch(/^FINA\/\d{4}C\/\d{5}$/);
    expect(cn).toMatchObject({ originalInvoiceId: inv.id, reason: "Half the order was cold" });
    expect([num(cn.total), num(cn.taxableValue), num(cn.totalTax), num(cn.cgst), num(cn.sgst)]).toEqual([105, 100, 5, 2.5, 2.5]);
    await refundPayment(sys, o.paymentId, { amount: 105 });
    docs = await getOrderInvoices(prisma, o.orderId);
    const notes = docs.filter((d) => d.kind === "CREDIT_NOTE");
    expect(notes).toHaveLength(2);
    expect(notes.reduce((a, d) => a + num(d.total), 0)).toBe(num(inv.total)); // fully credited
    expect((await getOrderBill(prisma, manager, o.orderId)).creditNotes).toHaveLength(2);

    // A series ending in "C" (e.g. derived from HYDCEN): credit note 1 must not collide with invoice 1.
    const cSeries = (await prisma.outlet.create({ data: { organizationId: orgId, code: `FC${RUN}`, name: "Fin C", gstin: GSTIN_TS, invoiceSeries: "HYDC" } })).id;
    const cOrder = await paidOrder(cSeries, [{ menuItemId: dosa, qty: 1 }], 0, "UPI");
    await refundPayment(sys, cOrder.paymentId, { amount: 105 });
    const cDocs = await getOrderInvoices(prisma, cOrder.orderId);
    expect(cDocs.map((d) => d.number.replace(/\/\d{4}/, "/FY"))).toEqual(["HYDC/FY/00001", "HYDC/FYC/00001"]);

    // Petpooja orders carry the platform's own invoice.
    const imported = await processPOSOrder(sys, { externalRef: `pp-${RUN}`, eventId: `ev-pp-${RUN}`, outletId: A, source: "PETPOOJA", channel: "DINE_IN", placedAt: new Date(), items: [{ posItemCode: "X", name: "X", qty: 1, unitPrice: 50, taxPct: 5 }], payments: [{ method: "UPI", amount: 52.5, providerRef: `pp-pay-${RUN}` }], settled: true });
    expect(await prisma.taxInvoice.count({ where: { orderId: imported.orderId } })).toBe(0);
    await expect(issueInvoice(manager, imported.orderId!)).rejects.toThrow(/invoiced by its ordering platform/);
    // Payments that add up to the total raise nothing...
    expect(await prisma.anomaly.count({ where: { entityType: "Order", entityId: imported.orderId } })).toBe(0);
    // ...a settled import whose provider payments do not (pre-tax amount reported) is accepted but flagged.
    const short = await processPOSOrder(sys, { externalRef: `pp-short-${RUN}`, eventId: `ev-pp-short-${RUN}`, outletId: A, source: "PETPOOJA", channel: "DINE_IN", placedAt: new Date(), items: [{ posItemCode: "X", name: "X", qty: 1, unitPrice: 50, taxPct: 5 }], payments: [{ method: "UPI", amount: 50, providerRef: `pp-pay-short-${RUN}` }], settled: true });
    const flagged = await prisma.anomaly.findMany({ where: { entityType: "Order", entityId: short.orderId } });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ type: "RECONCILIATION_MISMATCH", status: "OPEN" });
    expect(flagged[0].message).toMatch(/shortfall ₹2\.50/);
  });

  it("GSTIN and invoice series on an outlet are validated and need an org-wide role", async () => {
    await expect(updateOutlet(manager, A, { gstin: "36ABCDE1234F1Z5" })).rejects.toBeInstanceOf(ZodError);
    await expect(updateOutlet(manager, A, { gstin: GSTIN_TS })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOutlet(owner, A, { invoiceSeries: "TOOLONG" })).rejects.toBeInstanceOf(ZodError);
    expect((await updateOutlet(owner, A, { invoiceSeries: "FINA" })).invoiceSeries).toBe("FINA");
    await expect(listInvoices(prisma, kitchen, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listInvoices(prisma, managerB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listInvoices(prisma, manager, { outletId: A })).length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------
describe("expenses, petty cash and the cash drawer", () => {
  it("expenses: categories, duplicate protection, 2 decimals, no future dates, RBAC", async () => {
    const cats = (await listExpenseCategories(prisma, manager)).map((c) => c.name);
    expect(cats).toEqual(expect.arrayContaining(["RENT", "UTILITIES", "GAS", "MISC"]));
    const input = { outletId: A, category: "GAS", amount: 1250.5, description: "2 cylinders" };
    const k = key("exp");
    const first = await createExpense(manager, input, undefined, k);
    expect((await createExpense(manager, input, undefined, k))).toMatchObject({ id: first.id, replayed: true });
    await expect(createExpense(manager, { ...input, amount: 1300 }, undefined, k)).rejects.toBeInstanceOf(ConflictError);
    const k2 = key("exp");
    const both = await Promise.all([createExpense(manager, input, undefined, k2), createExpense(manager, input, undefined, k2)]);
    expect(both[0].id).toBe(both[1].id);
    await expect(createExpense(manager, { ...input, amount: 10.005 })).rejects.toBeInstanceOf(ZodError);
    await expect(createExpense(manager, { ...input, amount: -5 })).rejects.toBeInstanceOf(ZodError);
    await expect(createExpense(manager, { ...input, category: "YACHT" })).rejects.toThrow(/Unknown or inactive/);
    await expect(createExpense(manager, { ...input, spentAt: new Date(Date.now() + 2 * 86_400_000) })).rejects.toThrow(/future/);
    await expect(createExpense(kitchen, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createExpense(managerB, input)).rejects.toBeInstanceOf(ForbiddenError);
    // Category management is org-wide.
    await expect(createExpenseCategory(manager, { name: "LAUNDRY" })).rejects.toBeInstanceOf(ForbiddenError);
    const laundry = await createExpenseCategory(owner, { name: "LAUNDRY" });
    await createExpense(manager, { ...input, category: "LAUNDRY", amount: 300 });
    await setExpenseCategoryActive(owner, laundry.id, false);
    await expect(createExpense(manager, { ...input, category: "LAUNDRY", amount: 300 })).rejects.toThrow(/inactive/);
  });

  it("voiding an expense removes it from every total and returns petty cash; void is one-shot and audited", async () => {
    await recordPettyCash(manager, { outletId: A, type: "OPENING", amount: 2000 });
    const k = key("petty");
    await recordPettyCash(manager, { outletId: A, type: "ADD", amount: 500 }, undefined, k);
    await recordPettyCash(manager, { outletId: A, type: "ADD", amount: 500 }, undefined, k); // retry
    expect(await pettyCashBalance(prisma, manager, A)).toBe(2500);
    const e = await createExpense(manager, { outletId: A, category: "REPAIRS", amount: 800, paidVia: "PETTY_CASH" });
    expect(await pettyCashBalance(prisma, manager, A)).toBe(1700);
    const before = (await expensesByCategory(prisma, manager, { outletId: A })).find((c) => c.category === "REPAIRS")!.amount;
    await expect(voidExpense(manager, e.id, "")).rejects.toBeInstanceOf(ZodError);
    await expect(voidExpense(foreign, e.id, "wrong tenant")).rejects.toBeInstanceOf(NotFoundError);
    await voidExpense(manager, e.id, "Entered against the wrong outlet");
    await expect(voidExpense(manager, e.id, "again")).rejects.toThrow(/already void/);
    expect(await pettyCashBalance(prisma, manager, A)).toBe(2500);
    expect((await expensesByCategory(prisma, manager, { outletId: A })).find((c) => c.category === "REPAIRS")?.amount ?? 0).toBe(before - 800);
    expect((await listExpenses(prisma, manager, { outletId: A })).some((x) => x.id === e.id)).toBe(false);
    expect((await listExpenses(prisma, manager, { outletId: A, includeVoided: true })).some((x) => x.id === e.id)).toBe(true);
    const exp = await getReport(prisma, manager, "EXPENSES", { outletId: A });
    expect(exp.rows.some((r) => r.amount === 800 && r.category === "REPAIRS")).toBe(false);
    const pnl = await computePnL(prisma, manager, { outletId: A });
    expect(pnl.expenses).toBe(num((await prisma.expense.aggregate({ where: { outletId: A, voidedAt: null }, _sum: { amount: true } }))._sum.amount!));
    const audit = await getReport(prisma, owner, "FINANCE_AUDIT", { outletId: A });
    expect(audit.rows.some((r) => r.entity === "Expense" && r.action === "VOID" && r.entityId === e.id)).toBe(true);
  });

  it("drawer: pay-ins and pay-outs move expected cash; pay-outs cannot exceed it; close freezes expected + variance", async () => {
    const s = await openCashDrawer(cashier, { outletId: B === "" ? A : U, openingFloat: 1000 }).catch(() => openCashDrawer(sys, { outletId: U, openingFloat: 1000 }));
    const sale = await paidOrder(U, [{ menuItemId: dosa, qty: 2 }]); // 210 cash
    const k = key("mv");
    await recordDrawerMovement(sys, s.id, { type: "PAY_IN", amount: 500, reason: "Float top-up" }, undefined, k);
    expect((await recordDrawerMovement(sys, s.id, { type: "PAY_IN", amount: 500, reason: "Float top-up" }, undefined, k)).replayed).toBe(true);
    await recordDrawerMovement(sys, s.id, { type: "PAY_OUT", amount: 300, reason: "Paid the milk vendor" });
    await expect(recordDrawerMovement(sys, s.id, { type: "PAY_OUT", amount: 5000, reason: "Too much" })).rejects.toThrow(/exceeds/);
    await expect(recordDrawerMovement(sys, s.id, { type: "PAY_OUT", amount: 1, reason: "" })).rejects.toBeInstanceOf(ZodError);
    const closed = await closeCashDrawer(sys, s.id, 1400); // expected 1000 + 210 + 500 - 300 = 1410
    expect(closed).toMatchObject({ expectedCash: 1410, variance: -10 });
    const row = await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: s.id } });
    expect([num(row.expectedCash!), num(row.variance!)]).toEqual([1410, -10]);
    await expect(recordDrawerMovement(sys, s.id, { type: "PAY_IN", amount: 1, reason: "late" })).rejects.toThrow(/closed/);
    const rep = await getReport(prisma, owner, "CASH_DRAWER", { outletId: U });
    expect(rep.rows.find((r) => r.expected === 1410)).toMatchObject({ payIn: 500, payOut: 300, counted: 1400, variance: -10 });
    void sale;
  });

  it("cash reconciliation (counted vs expected per method) and daily closing figures", async () => {
    const today = new Date();
    // Cash taken at U today: 105 (unregistered-invoice test) + 210 (drawer test) = 315; 305 counted.
    const recon = await saveDailyReconciliation(sys, { outletId: U, businessDate: today, actuals: [{ method: "CASH", actual: 305 }], finalize: true });
    const cash = recon.lines.find((l) => l.method === "CASH")!;
    expect([num(cash.expected), num(cash.actual), num(cash.difference)]).toEqual([315, 305, -10]);
    expect(recon.status).toBe("COMPLETED");
    const day = await dailyClosing(prisma, sys, U, today);
    expect(day.invoices.issued).toBeGreaterThanOrEqual(2);
    expect(day.drawerVariance).toBe(-10);
  });

  it("online (gateway) payments reconcile against the gateway settlement report", async () => {
    const o = await placeOrder(sys, { outletId: B, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 1 }] });
    const p = await createPayment(sys, o.id, { method: "ONLINE", amount: 105, provider: "mock", providerRef: `gw-${RUN}` });
    await verifyPayment(sys, p.id);
    const ok = await runPaymentReconciliation(sys, { outletId: B, businessDate: new Date(), provider: new MockPaymentProvider([{ providerRef: `gw-${RUN}`, amount: 105, status: "CAPTURED", settledAt: new Date() }]) });
    expect(ok.lines.filter((l) => l.method === `payment:gw-${RUN}`)).toHaveLength(0); // matched: no exception line
    const bad = await runPaymentReconciliation(sys, { outletId: B, businessDate: new Date(), provider: new MockPaymentProvider([{ providerRef: `gw-${RUN}`, amount: 100, status: "CAPTURED", settledAt: new Date() }]) });
    expect(bad.lines.find((l) => l.method === `payment:gw-${RUN}`)?.note).toMatch(/^MISMATCHED/);
  });
});

// ------------------------------------------------------------------
describe("vendor payables", () => {
  const bill = (amount: number, extra: object = {}) => createPurchaseBill(owner, { outletId: A, vendorId: vendor, lines: [{ materialId: rice, qty: 1, rate: amount }], ...extra });

  it("partial payments, overpayment refused, duplicates replay, concurrent payments never overpay", async () => {
    const b = await bill(1000, { dueDate: new Date(Date.now() - 45 * 86_400_000) });
    const k = key("vpay");
    const p1 = await payVendor(owner, { outletId: A, vendorId: vendor, billId: b.id, amount: 400, idempotencyKey: k });
    expect((await payVendor(owner, { outletId: A, vendorId: vendor, billId: b.id, amount: 400, idempotencyKey: k })).id).toBe(p1.id);
    expect((await prisma.purchaseBill.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("PARTIAL");
    await expect(payVendor(owner, { outletId: A, vendorId: vendor, billId: b.id, amount: 600.01 })).rejects.toThrow(/exceeds outstanding/);
    await expect(payVendor(owner, { outletId: A, vendorId: vendor, billId: b.id, amount: 0.001 })).rejects.toBeInstanceOf(ZodError);
    await expect(payVendor(cashier, { outletId: A, vendorId: vendor, billId: b.id, amount: 10 })).rejects.toBeInstanceOf(ForbiddenError);
    const res = await Promise.allSettled([400, 400].map((amount) => payVendor(owner, { outletId: A, vendorId: vendor, billId: b.id, amount })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1); // 400 + 400 + 400 > 1000
    const after = await prisma.purchaseBill.findUniqueOrThrow({ where: { id: b.id } });
    expect([num(after.paidAmount), after.status]).toEqual([800, "PARTIAL"]);
    // Aging: 200 due, 45 days past due.
    const row = (await vendorAging(prisma, owner, { outletId: A, vendorId: vendor })).find((r) => r.vendorId === vendor)!;
    expect(row.d31_60).toBeGreaterThanOrEqual(200);
  });

  it("reversing a payment restores the bill balance and status; statements and aging follow; cancel rules", async () => {
    const b = await bill(500);
    const p = await payVendor(owner, { outletId: A, vendorId: vendor, billId: b.id, amount: 500, reference: `CHQ-${RUN}` });
    expect((await prisma.purchaseBill.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("PAID");
    await expect(cancelPurchaseBill(owner, b.id)).rejects.toThrow(/Illegal bill transition: PAID -> CANCELLED/); // a paid bill is never cancelled
    await expect(reverseVendorPayment(cashier, p.id, "bounced")).rejects.toBeInstanceOf(ForbiddenError);
    await reverseVendorPayment(owner, p.id, "Cheque bounced");
    await expect(reverseVendorPayment(owner, p.id, "again")).rejects.toThrow(/already reversed/);
    const after = await prisma.purchaseBill.findUniqueOrThrow({ where: { id: b.id } });
    expect([num(after.paidAmount), after.status]).toEqual([0, "OPEN"]);
    const st = await vendorStatement(prisma, owner, { vendorId: vendor, outletId: A });
    expect(st.entries.filter((e) => e.reference === `CHQ-${RUN}`).map((e) => e.type)).toEqual(["PAYMENT", "REVERSAL"]);
    expect(st.closing).toBe(st.entries.at(-1)!.balance);
    // Only reversed payments left: the bill may now be cancelled, and leaves the payables.
    await cancelPurchaseBill(owner, b.id);
    expect(st.entries.some((e) => e.reference === b.number)).toBe(true);
    const st2 = await vendorStatement(prisma, owner, { vendorId: vendor, outletId: A });
    expect(st2.entries.find((e) => e.reference === b.number)).toMatchObject({ type: "CANCELLED_BILL", credit: 0 });
  });

  it("advances (unallocated payments) reduce the net payable; other tenants see nothing", async () => {
    const before = (await vendorAging(prisma, owner, { outletId: A, vendorId: vendor }))[0];
    await payVendor(owner, { outletId: A, vendorId: vendor, amount: 150, method: "UPI" });
    const after = (await vendorAging(prisma, owner, { outletId: A, vendorId: vendor }))[0];
    expect(after.advances - (before?.advances ?? 0)).toBe(150);
    expect(after.netPayable).toBeCloseTo(after.totalDue - after.advances, 2);
    expect(await vendorAging(prisma, foreign, {})).toEqual([]);
    await expect(vendorStatement(prisma, foreign, { vendorId: vendor })).rejects.toBeInstanceOf(NotFoundError);
    const rep = await getReport(prisma, owner, "VENDOR_AGING", { outletId: A });
    expect(rep.rows.find((r) => r.vendor === `Veg Co ${RUN}`)).toMatchObject({ netPayable: after.netPayable });
  });
});

// ------------------------------------------------------------------
describe("finance reports", () => {
  it("tax summary nets credit notes; sales vs payments; outstanding balances; discounts", async () => {
    const tax = await getReport(prisma, owner, "TAX_SUMMARY", { outletId: A });
    const inv5 = tax.rows.find((r) => r.kind === "INVOICE" && r.rate === 5)!;
    const cn5 = tax.rows.find((r) => r.kind === "CREDIT_NOTE" && r.rate === 5)!;
    expect(Number(inv5.cgst) + Number(inv5.sgst)).toBeCloseTo(Number(inv5.totalTax), 2);
    expect(cn5.totalTax).toBe(10); // the two refund credit notes above
    const reg = await getReport(prisma, owner, "INVOICES", { outletId: A });
    expect(new Set(reg.rows.map((r) => r.number)).size).toBe(reg.rows.length);
    const svp = await getReport(prisma, owner, "SALES_VS_PAYMENTS", { outletId: A });
    expect(svp.rows[0]).toMatchObject({ refunded: expect.any(Number) });
    const open = await placeOrder(sys, { outletId: A, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: dosa, qty: 4 }] }); // 420
    const part = await createPayment(sys, open.id, { method: "CASH", amount: 100 });
    await verifyPayment(sys, part.id);
    const out = await getReport(prisma, owner, "OUTSTANDING_ORDERS", { outletId: A });
    expect(out.rows.find((r) => r.orderId === open.id)).toMatchObject({ total: 420, paid: 100, balance: 320 });
    const disc = await getReport(prisma, owner, "DISCOUNTS", { outletId: A });
    expect(disc.rows.some((r) => r.discount === 20)).toBe(true);
    await expect(getReport(prisma, kitchen, "TAX_SUMMARY", { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReport(prisma, cashier, "FINANCE_AUDIT", { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    void ValidationError;
  });
});
