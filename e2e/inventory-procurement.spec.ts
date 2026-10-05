/**
 * Phase 3 through the real screens (production build, real API + database):
 *  - INV-P3-001 opening stock for a new material, then a manual adjustment with
 *    a reason, from the Stock screen; server stock, average cost, ledger and the
 *    adjustments report are read back through the API; a conflicting second
 *    opening entry is refused in the dialog.
 *  - PROC-P3-001 a bill created from a posted GRN carries the vendor invoice
 *    number; the same vendor invoice cannot be billed again, and the GRN's
 *    received quantity cannot be billed twice.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, materialByName, stockQty, apiData, apiAs, apiCall, CENTRAL } from "./helpers";

test.use({ storageState: statePath("manager") });

const RUN = Date.now().toString(36);

test.describe("inventory & procurement (Phase 3)", () => {
  test("INV-P3-001 opening stock and a reasoned adjustment from the Stock screen", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const owner = await apiAs("owner");
    const units = await apiData<Array<{ id: string; code: string }>>(owner, "/api/master/units");
    const kg = units.find((u) => u.code === "kg")!;
    const created = await apiCall<{ id: string }>(owner, "POST", "/api/master/materials", { sku: `E2E-SAFFRON-${RUN}`, name: `E2E Saffron ${RUN}`, baseUnitId: kg.id });
    expect(created.status, JSON.stringify(created.body?.error)).toBe(200);
    const saffron = created.body!.data;

    await page.goto("/inventory");
    await page.getByRole("button", { name: "Opening stock" }).click();
    let dlg = page.getByRole("dialog", { name: "Opening stock" });
    await dlg.getByLabel("Line 1 material").selectOption(saffron.id);
    await dlg.getByLabel("Line 1 Qty (base unit)").fill("10");
    await dlg.getByLabel("Line 1 Cost per unit").fill("120");
    await dlg.getByRole("button", { name: "Post opening stock" }).click();
    await expect(dlg).toBeHidden();
    expect(await stockQty(page.request, outlet.id, saffron.id)).toBe(10);

    // A second, different opening entry for the same material is refused (adjust instead).
    await page.getByRole("button", { name: "Opening stock" }).click();
    dlg = page.getByRole("dialog", { name: "Opening stock" });
    await dlg.getByLabel("Line 1 material").selectOption(saffron.id);
    await dlg.getByLabel("Line 1 Qty (base unit)").fill("12");
    await dlg.getByLabel("Line 1 Cost per unit").fill("120");
    await dlg.getByRole("button", { name: "Post opening stock" }).click();
    await expect(dlg.getByText(/already posted with different values/)).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    expect(await stockQty(page.request, outlet.id, saffron.id)).toBe(10);

    await page.getByRole("button", { name: "Adjust stock" }).click();
    dlg = page.getByRole("dialog", { name: "Adjust stock" });
    await dlg.getByLabel(/^Material/).selectOption(saffron.id);
    await dlg.getByLabel(/^Direction/).selectOption("OUT");
    await dlg.getByLabel(/^Quantity/).fill("1.5");
    await dlg.getByLabel(/^Reason/).selectOption("THEFT_OR_LOSS");
    await dlg.getByLabel(/^Explanation/).fill(`Missing tin ${RUN}`);
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/inventory/adjustments");
    await dlg.getByRole("button", { name: "Post adjustment" }).click();
    const res = await posted;
    expect(res.status()).toBe(200);
    expect(res.request().headers()["idempotency-key"]).toMatch(/^adj-/);
    await expect(dlg).toBeHidden();

    expect(await stockQty(page.request, outlet.id, saffron.id)).toBe(8.5);
    const stock = await apiData<Array<{ materialId: string; avgCost: number }>>(page.request, `/api/inventory/stock?outletId=${outlet.id}`);
    expect(stock.find((r) => r.materialId === saffron.id)!.avgCost).toBe(120); // adjustments never move the average
    const report = await apiData<{ rows: Array<{ material: string; reason: string; qty: number }> }>(page.request, `/api/reports/STOCK_ADJUSTMENTS?outletId=${outlet.id}`);
    expect(report.rows.find((r) => r.material === `E2E Saffron ${RUN}` && r.qty === -1.5)?.reason).toBe(`THEFT_OR_LOSS: Missing tin ${RUN}`);
    await expect(page.getByRole("table", { name: "Stock on hand" }).getByText(`E2E Saffron ${RUN}`)).toBeVisible();
  });

  test("PROC-P3-001 a vendor invoice is billed once; received quantity is never billed twice", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const cashew = await materialByName(page.request, "Cashew");
    const vendors = await apiData<{ items: Array<{ id: string; name: string }> }>(page.request, "/api/master/vendors?take=200");
    const vendor = vendors.items.find((v) => v.name === "Karachi Bakery Supplies")!;
    const grn = await apiCall<{ id: string; number: string }>(page.request, "POST", "/api/procurement/grns", { outletId: outlet.id, vendorId: vendor.id, lines: [{ materialId: cashew.id, qty: 4, rate: 800, damagedQty: 1 }] }, { "idempotency-key": `e2e-grn-${RUN}` });
    expect(grn.status, JSON.stringify(grn.body?.error)).toBe(200);
    // A retried submission with the same key is the same GRN.
    const again = await apiCall<{ id: string }>(page.request, "POST", "/api/procurement/grns", { outletId: outlet.id, vendorId: vendor.id, lines: [{ materialId: cashew.id, qty: 4, rate: 800, damagedQty: 1 }] }, { "idempotency-key": `e2e-grn-${RUN}` });
    expect(again.body!.data.id).toBe(grn.body!.data.id);
    expect((await apiCall(page.request, "POST", `/api/procurement/grns/${grn.body!.data.id}/post`)).status).toBe(200);

    await page.goto(`/procurement/grns/${grn.body!.data.id}`);
    await page.getByRole("button", { name: "Create bill" }).click();
    const dlg = page.getByRole("dialog", { name: `Bill for GRN ${grn.body!.data.number}` });
    await expect(dlg.getByLabel("Line 1 Qty")).toHaveValue("3"); // accepted = 4 delivered − 1 rejected
    await dlg.getByLabel("Vendor invoice no.").fill(`KBS-${RUN}`);
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/procurement/bills");
    await dlg.getByRole("button", { name: "Create bill" }).click();
    const bill = (await (await created).json()) as { data: { id: string; vendorInvoiceNo: string } };
    expect(bill.data.vendorInvoiceNo).toBe(`KBS-${RUN}`);

    // Same vendor invoice again (even without the GRN) -> 409; the GRN's quantity again -> 422.
    const dupInvoice = await apiCall<unknown>(page.request, "POST", "/api/procurement/bills", { outletId: outlet.id, vendorId: vendor.id, vendorInvoiceNo: `KBS-${RUN}`, lines: [{ materialId: cashew.id, qty: 1, rate: 800 }] });
    expect(dupInvoice.status).toBe(409);
    const dupQty = await apiCall<unknown>(page.request, "POST", "/api/procurement/bills", { outletId: outlet.id, vendorId: vendor.id, grnId: grn.body!.data.id, lines: [{ materialId: cashew.id, qty: 1, rate: 800 }] });
    expect(dupQty.status).toBe(422);
    expect(dupQty.body!.error!.message).toMatch(/exceeds the 0 received and not yet billed/);
  });
});
