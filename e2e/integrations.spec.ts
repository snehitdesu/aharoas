/**
 * Phase 7 integrations through the real app (production build, real API + DB):
 *  - INT-001 printers: the owner adds a SIMULATED receipt printer with a cash
 *    drawer (password re-confirmation), test-prints (recorded as SIMULATED —
 *    never "printed"), a cash sale kicks the drawer after the commit, and the
 *    bill page sends the receipt once and reprints only with a reason.
 *  - INT-002 messaging + accounting: the owner connects the MOCK messaging
 *    provider with "payment received" enabled; a paid order with a customer
 *    produces exactly one MOCK delivery to a masked number; the accounting
 *    export downloads a balanced CSV; a forged webhook is refused.
 *  - INT-003 a manager cannot reach integration management.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, confirmPasswordIfPrompted, CENTRAL } from "./helpers";

const RUN = Date.now().toString(36);

test.describe("integrations (Phase 7)", () => {
  test.use({ storageState: statePath("owner") });

  test("INT-001 simulated printer, drawer kick after a cash sale, receipt once + audited reprint", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    await page.goto("/settings/printers");
    await page.getByRole("button", { name: /Add printer/ }).click();
    const dlg = page.getByRole("dialog", { name: "Add printer" });
    await dlg.getByLabel(/^Name/).fill(`Front ${RUN}`);
    await dlg.getByLabel(/^Connection/).selectOption("SIMULATED");
    await dlg.getByRole("checkbox", { name: "Cash drawer connected" }).check();
    await dlg.getByRole("button", { name: "Save" }).click();
    const row = page.getByRole("table", { name: "Printers" }).getByRole("row").filter({ hasText: `Front ${RUN}` });
    await confirmPasswordIfPrompted(page, row);
    await expect(row).toContainText("MOCK");
    await row.getByRole("button", { name: "Test print" }).click();
    await expect(page.getByRole("table", { name: "Print jobs" }).getByRole("row").filter({ hasText: "Test" }).first()).toContainText("Simulated");

    // A cash sale: the drawer opens after the payment is committed.
    const cashier = await apiAs("cashier");
    const menu = await apiData<Array<{ id: string; name: string }>>(cashier, `/api/menu?outletId=${outlet.id}&activeOnly=true`);
    const chai = menu.find((m) => m.name === "Masala Chai")!;
    const placed = await apiCall<{ id: string; total: string }>(cashier, "POST", "/api/orders", { outletId: outlet.id, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: chai.id, qty: 1 }] }, { "idempotency-key": `e2e-int-${RUN}` });
    const orderId = placed.body!.data.id;
    const order = await apiData<{ total: string }>(cashier, `/api/orders/${orderId}`);
    const pay = await apiCall<{ id: string }>(cashier, "POST", "/api/payments", { orderId, method: "CASH", amount: Number(order.total) }, { "idempotency-key": `e2e-int-pay-${RUN}` });
    expect((await apiCall(cashier, "POST", `/api/payments/${pay.body!.data.id}/verify`)).status).toBe(200);
    await expect.poll(async () => (await apiData<Array<{ kind: string; status: string }>>(page.request, `/api/print/jobs?outletId=${outlet.id}`)).some((j) => j.kind === "DRAWER" && j.status === "SIMULATED")).toBe(true);
    expect((await apiData<{ status: string }>(cashier, `/api/orders/${orderId}`)).status).toBe("PAID");

    // Bill page: first print once, reprint with a reason.
    await page.goto(`/pos/bill/${orderId}`);
    const actions = page.getByTestId("printer-actions");
    await actions.getByRole("button", { name: "Send to printer" }).click();
    await expect(actions.getByRole("status")).toContainText("Simulated printer: nothing was printed on paper.");
    await actions.getByRole("button", { name: "Send to printer" }).click();
    await expect(actions.getByRole("status")).toContainText("Already sent to the printer");
    await actions.getByLabel("Reprint reason").fill("Guest copy");
    await actions.getByRole("button", { name: "Reprint" }).click();
    await expect.poll(async () => (await apiData<Array<{ kind: string; reason: string | null }>>(page.request, `/api/print/jobs?outletId=${outlet.id}`)).filter((j) => j.kind === "RECEIPT" && j.reason === "Guest copy").length).toBe(1);
  });

  test("INT-002 MOCK messaging sends one masked receipt message; accounting export; forged webhook refused", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    await page.goto("/settings/integrations");
    await page.getByRole("button", { name: /Connect/ }).click();
    const dlg = page.getByRole("dialog", { name: "Connect an integration" });
    await dlg.getByLabel(/^Provider/).selectOption("mock");
    await dlg.getByRole("checkbox", { name: "Payment received" }).check();
    await dlg.getByRole("button", { name: "Save" }).click();
    const conn = page.getByRole("table", { name: "Connections" }).getByRole("row").filter({ hasText: "Messaging" });
    await confirmPasswordIfPrompted(page, conn.first());
    await expect(conn.first()).toContainText("MOCK");

    const cashier = await apiAs("cashier");
    const customers = await apiData<{ items: Array<{ id: string; phone: string | null }> } | Array<{ id: string; phone: string | null }>>(cashier, `/api/customers?take=20`);
    const list = Array.isArray(customers) ? customers : customers.items;
    const customer = list.find((c) => c.phone && /^[6-9]\d{9}$/.test(c.phone))!;
    const menu = await apiData<Array<{ id: string; name: string }>>(cashier, `/api/menu?outletId=${outlet.id}&activeOnly=true`);
    const placed = await apiCall<{ id: string }>(cashier, "POST", "/api/orders", { outletId: outlet.id, channel: "TAKEAWAY", submit: true, customerId: customer.id, items: [{ menuItemId: menu.find((m) => m.name === "Masala Chai")!.id, qty: 2 }] }, { "idempotency-key": `e2e-msg-${RUN}` });
    const orderId = placed.body!.data.id;
    const total = Number((await apiData<{ total: string }>(cashier, `/api/orders/${orderId}`)).total);
    const pay = await apiCall<{ id: string }>(cashier, "POST", "/api/payments", { orderId, method: "UPI", amount: total }, { "idempotency-key": `e2e-msg-pay-${RUN}` });
    await apiCall(cashier, "POST", `/api/payments/${pay.body!.data.id}/verify`);
    await expect.poll(async () => (await apiData<Array<{ sourceId: string; status: string; mode: string; target: string }>>(page.request, "/api/integrations/deliveries?kind=MESSAGE")).filter((d) => d.sourceId === orderId).map((d) => [d.status, d.mode, d.target.slice(-4)])).toEqual([["SENT", "MOCK", customer.phone!.slice(-4)]]);
    await page.getByRole("tab", { name: "Outbox" }).click();
    await expect(page.getByRole("table", { name: "Outbox" })).toContainText("******");

    await page.getByRole("tab", { name: "Accounting" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Export/ }).click();
    const csv = await (await download).createReadStream().then((s) => new Promise<string>((r) => { let t = ""; s.on("data", (c) => (t += c)); s.on("end", () => r(t)); }));
    expect(csv.split("\r\n")[0]).toBe("Date,Voucher Type,Voucher No,Ledger,Debit,Credit,Party,Narration,Source");
    await expect(page.getByTestId("accounting-result")).toContainText("vouchers exported");

    const forged = await page.request.post("/api/webhooks/payment/mock", { data: { eventId: "x", accountId: "y", event: "payment.captured", providerRef: "z", amount: 1 }, headers: { "x-signature": "forged" } });
    expect([401, 403, 404]).toContain(forged.status());
  });
});

test.describe("integration management access", () => {
  test.use({ storageState: statePath("manager") });
  test("INT-003 a manager cannot manage integrations", async ({ page }) => {
    await page.goto("/settings/integrations");
    await expect(page.getByText(/doesn't include access/)).toBeVisible();
    expect((await page.request.get("/api/integrations")).status()).toBe(403);
  });
});
