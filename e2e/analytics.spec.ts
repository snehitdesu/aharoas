/**
 * Phase 5 analytics through the real app (production build, real API + DB):
 *  - ANA-001 a discounted POS order and its full refund move today's analytics
 *    exactly once: the sale stays (orders +1, gross +560, discount +60), the
 *    refund is netted on its business day (refunds +525, ex tax +500) and net
 *    sales return to where they were — no double count. Item revenue carries
 *    the discount; the cash method shows collected / refunded / net.
 *  - ANA-002 the Analytics screen renders sales, menu, insights and the
 *    finance tab (P&L labelled an estimate) from the same API.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, PASSWORD, CENTRAL } from "./helpers";

test.use({ storageState: statePath("manager") });

const RUN = Date.now().toString(36);
type Summary = { orders: number; refundedOrders: number; grossSales: number; discounts: number; refunds: number; refundsExTax: number; netSales: number };
type Method = { method: string; collected: number; refunded: number; net: number };
type Item = { name: string; qty: number; grossRevenue: number; discount: number; refundedQty: number; refundedRevenue: number; netRevenue: number };

test.describe("analytics (Phase 5)", () => {
  test("ANA-001 a full refund is netted once; item revenue is after discount", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const day = await page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
    const q = `outletId=${outlet.id}&from=${day}&to=${day}`;
    const before = await apiData<Summary>(page.request, `/api/analytics/sales-summary?${q}`);
    const cashBefore = (await apiData<Method[]>(page.request, `/api/analytics/payments?${q}`)).find((m) => m.method === "CASH") ?? { collected: 0, refunded: 0, net: 0 };
    const itemBefore = (await apiData<Item[]>(page.request, `/api/analytics/items?${q}`)).find((i) => i.name === "Paneer Tikka") ?? { qty: 0, grossRevenue: 0, discount: 0, refundedQty: 0, refundedRevenue: 0, netRevenue: 0 };

    const cashier = await apiAs("cashier");
    const menu = await apiData<Array<{ id: string; name: string }>>(cashier, `/api/menu?outletId=${outlet.id}&activeOnly=true`);
    const tikka = menu.find((m) => m.name === "Paneer Tikka")!;
    const placed = await apiCall<{ id: string }>(cashier, "POST", "/api/orders", { outletId: outlet.id, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: tikka.id, qty: 2 }] }, { "idempotency-key": `e2e-ana-${RUN}` });
    expect(placed.status, JSON.stringify(placed.body?.error)).toBe(200);
    const orderId = placed.body!.data.id;
    expect((await apiCall(cashier, "POST", `/api/orders/${orderId}/discount`, { amount: 60 })).status).toBe(200);
    const pay = await apiCall<{ id: string }>(cashier, "POST", "/api/payments", { orderId, method: "CASH", amount: 525 }, { "idempotency-key": `e2e-ana-pay-${RUN}` });
    expect((await apiCall(cashier, "POST", `/api/payments/${pay.body!.data.id}/verify`)).status).toBe(200);

    const paid = await apiData<Summary>(page.request, `/api/analytics/sales-summary?${q}`);
    expect(paid.orders).toBe(before.orders + 1);
    expect(paid.grossSales).toBeCloseTo(before.grossSales + 560, 2);
    expect(paid.discounts).toBeCloseTo(before.discounts + 60, 2);
    expect(paid.netSales).toBeCloseTo(before.netSales + 500, 2);
    const item = (await apiData<Item[]>(page.request, `/api/analytics/items?${q}`)).find((i) => i.name === "Paneer Tikka")!;
    expect(item.grossRevenue).toBeCloseTo(itemBefore.grossRevenue + 560, 2);
    expect(item.discount).toBeCloseTo(itemBefore.discount + 60, 2);
    expect(item.netRevenue).toBeCloseTo(itemBefore.netRevenue + 500, 2);

    // Full refund (behind the real password re-confirmation) -> the order becomes REFUNDED.
    const owner = await apiAs("owner");
    expect((await apiCall(owner, "POST", "/api/auth/reauth", { password: PASSWORD, scope: "payment.refund" })).status).toBe(200);
    const refund = await apiCall(owner, "POST", `/api/payments/${pay.body!.data.id}/refund`, { amount: 525, reason: "E2E full refund", idempotencyKey: `e2e-ana-rf-${RUN}` });
    expect(refund.status, JSON.stringify(refund.body?.error)).toBe(200);
    expect((await apiData<{ status: string }>(cashier, `/api/orders/${orderId}`)).status).toBe("REFUNDED");

    const after = await apiData<Summary>(page.request, `/api/analytics/sales-summary?${q}`);
    expect(after.orders).toBe(before.orders + 1); // still a sale on its day
    expect(after.refundedOrders).toBe(before.refundedOrders + 1);
    expect(after.refunds).toBeCloseTo(before.refunds + 525, 2);
    expect(after.refundsExTax).toBeCloseTo(before.refundsExTax + 500, 2);
    expect(after.netSales).toBeCloseTo(before.netSales, 2); // netted exactly once
    const cash = (await apiData<Method[]>(page.request, `/api/analytics/payments?${q}`)).find((m) => m.method === "CASH")!;
    expect(cash.collected).toBeCloseTo(cashBefore.collected + 525, 2);
    expect(cash.refunded).toBeCloseTo(cashBefore.refunded + 525, 2);
    expect(cash.net).toBeCloseTo(cashBefore.net, 2);
    const refundedItem = (await apiData<Item[]>(page.request, `/api/analytics/items?${q}`)).find((i) => i.name === "Paneer Tikka")!;
    expect(refundedItem.refundedQty).toBe(itemBefore.refundedQty + 2);
    expect(refundedItem.netRevenue).toBeCloseTo(itemBefore.netRevenue, 2);
  });

  test("ANA-002 the Analytics screen: sales, menu, insights and an estimated P&L", async ({ page }) => {
    await page.goto("/analytics");
    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
    await expect(page.getByText("Net sales (ex tax)")).toBeVisible();
    await expect(page.getByRole("table", { name: "Sales trend" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Payment methods" }).getByText("Cash")).toBeVisible();

    await page.getByRole("tab", { name: "Menu" }).click();
    await expect(page.getByRole("table", { name: "Best sellers" }).getByText("Paneer Tikka")).toBeVisible();

    await page.getByRole("tab", { name: "Insights" }).click();
    await expect(page.getByText(/Rule-based checks over business days/)).toBeVisible();

    await page.getByRole("tab", { name: "Finance" }).click();
    await expect(page.getByText("Operational P&L (estimate)")).toBeVisible();
    await expect(page.getByText(/not accounting profit/)).toBeVisible();

    // Reversed range: refused in the screen and by the API.
    await page.getByRole("tab", { name: "Sales" }).click();
    await page.locator("#filter-from").fill("2099-01-01");
    await expect(page.getByText(/start date must be on or before/)).toBeVisible();
    expect((await apiCall(page.request, "GET", "/api/analytics/sales-summary?from=2026-05-02&to=2026-05-01")).status).toBe(422);
  });
});
