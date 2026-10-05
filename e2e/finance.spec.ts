/**
 * Phase 4 finance through the real screens (production build, real API + DB):
 *  - FIN-P4-001 an expense recorded from the dialog carries an Idempotency-Key;
 *    voiding it goes through the real password re-confirmation, takes it out of
 *    the list and the P&L, and is audited.
 *  - FIN-P4-002 a counter-paid POS order gets a sequential invoice; its bill
 *    shows the invoice number, the outlet GSTIN and CGST/SGST (tax after the
 *    discount) without calling itself a tax invoice; the tax summary has it.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, confirmPasswordIfPrompted, CENTRAL } from "./helpers";

test.use({ storageState: statePath("manager") });

const RUN = Date.now().toString(36);

test.describe("finance (Phase 4)", () => {
  test("FIN-P4-001 expense -> void with password confirmation -> out of the list and the P&L", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const pnlUrl = `/api/finance/pnl?outletId=${outlet.id}`;
    const before = await apiData<{ expenses: number }>(page.request, pnlUrl);

    await page.goto("/finance/expenses");
    await page.getByRole("button", { name: /Record expense/ }).click();
    const dlg = page.getByRole("dialog", { name: "Record expense" });
    await dlg.getByLabel(/^Category/).selectOption("GAS");
    await dlg.getByLabel(/^Amount/).fill("777.25");
    await dlg.getByLabel(/^Description/).fill(`E2E void ${RUN}`);
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/finance/expenses");
    await dlg.getByRole("button", { name: "Save expense" }).click();
    const res = await created;
    expect(res.request().headers()["idempotency-key"]).toMatch(/^exp-/);
    const expenseId = ((await res.json()) as { data: { id: string } }).data.id;
    const row = page.getByRole("table", { name: "Expenses" }).getByRole("row").filter({ hasText: `E2E void ${RUN}` });
    await expect(row).toBeVisible();
    expect((await apiData<{ expenses: number }>(page.request, pnlUrl)).expenses).toBeCloseTo(before.expenses + 777.25, 2);

    await row.getByRole("button", { name: "Void" }).click();
    const confirm = page.getByRole("dialog", { name: "Void this expense?" });
    await confirm.getByRole("textbox").fill("Recorded against the wrong bill");
    await confirm.getByRole("button", { name: "Void" }).click();
    await confirmPasswordIfPrompted(page, page.getByText("Expense voided"));
    await expect(row).toHaveCount(0);
    expect((await apiData<{ expenses: number }>(page.request, pnlUrl)).expenses).toBeCloseTo(before.expenses, 2);
    const all = await apiData<Array<{ id: string; voidedAt: string | null; voidReason: string | null }>>(page.request, `/api/finance/expenses?outletId=${outlet.id}&includeVoided=true&take=500`);
    expect(all.find((e) => e.id === expenseId)).toMatchObject({ voidReason: "Recorded against the wrong bill" });
    const audit = await apiData<{ rows: Array<{ entity: string; action: string; entityId: string }> }>(await apiAs("owner"), `/api/reports/FINANCE_AUDIT?outletId=${outlet.id}`);
    expect(audit.rows.some((r) => r.entity === "Expense" && r.action === "VOID" && r.entityId === expenseId)).toBe(true);
  });

  test("FIN-P4-002 a paid POS order is invoiced; the bill shows GST after discount; the tax summary includes it", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const cashier = await apiAs("cashier");
    const menu = await apiData<Array<{ id: string; name: string }>>(cashier, `/api/menu?outletId=${outlet.id}&activeOnly=true`);
    const tikka = menu.find((m) => m.name === "Paneer Tikka")!;
    const placed = await apiCall<{ id: string }>(cashier, "POST", "/api/orders", { outletId: outlet.id, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: tikka.id, qty: 2 }] }, { "idempotency-key": `e2e-fin-${RUN}` });
    expect(placed.status, JSON.stringify(placed.body?.error)).toBe(200);
    const orderId = placed.body!.data.id;
    expect((await apiCall(cashier, "POST", `/api/orders/${orderId}/discount`, { amount: 60 })).status).toBe(200);
    const order = await apiData<{ subtotal: string; tax: string; total: string }>(cashier, `/api/orders/${orderId}`);
    expect([Number(order.subtotal), Number(order.tax), Number(order.total)]).toEqual([560, 25, 525]); // (560 - 60) × 5% = 25
    const pay = await apiCall<{ id: string }>(cashier, "POST", "/api/payments", { orderId, method: "CASH", amount: 525 }, { "idempotency-key": `e2e-fin-pay-${RUN}` });
    expect((await apiCall(cashier, "POST", `/api/payments/${pay.body!.data.id}/verify`)).status).toBe(200);

    await page.goto(`/pos/bill/${orderId}`);
    const receipt = page.getByRole("article", { name: /^Receipt / });
    await expect(receipt).toContainText("GSTIN 36ABCDE1234F1Z1");
    await expect(receipt).toContainText("CGST 2.5% on ₹500.00");
    await expect(receipt).toContainText("SGST 2.5%");
    const number = (await page.getByTestId("invoice-number").innerText()).trim();
    expect(number).toMatch(/^HYDC\/\d{4}\/\d{5}$/);
    expect(await receipt.innerText()).not.toMatch(/Tax invoice|TAX INVOICE/);

    const tax = await apiData<Array<{ kind: string; ratePct: number; taxableValue: number; cgst: number; sgst: number }>>(page.request, `/api/finance/tax-summary?outletId=${outlet.id}`);
    const five = tax.find((t) => t.kind === "INVOICE" && t.ratePct === 5)!;
    expect(five.taxableValue).toBeGreaterThanOrEqual(500);
    expect(five.cgst).toBeCloseTo(five.sgst, 0);
    const invoices = await apiData<Array<{ number: string; orderId: string }>>(page.request, `/api/finance/invoices?outletId=${outlet.id}`);
    expect(invoices.find((i) => i.orderId === orderId)?.number).toBe(number);
  });
});
