/**
 * Phase 2 core transaction in real browsers, three parties at once:
 *   GUEST (phone, no account)  : table QR -> menu -> cart + modifiers -> order -> pay -> receipt
 *   POS   (cashier session)    : incoming QR order -> accept (KOT) -> bill / receipt
 *   KITCHEN (kitchen session)  : KOT -> Accept -> Start -> Ready -> Served
 * then stock consumption and sales data. Every step is checked against the
 * server (API / database state), not only the screen.
 *
 * The payment uses the development (mock) gateway: playwright.config.ts sets
 * ALLOW_MOCK_PROVIDERS=true for this disposable deployment. The guest page
 * labels it as a test gateway and the server still verifies every payment.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { statePath, outletByCode, order, openPos, toast, sessionFor, materialByName, stockQty, ledgerForOrder, apiAs, apiData, CENTRAL, money } from "./helpers";

test.use({ storageState: statePath("cashier") });

type TableRow = { id: string; code: string; qrToken: string | null };
type Summary = { orders: number; revenue: number };

async function qrToken(outletId: string, code: string) {
  const manager = await apiAs("manager");
  const t = (await apiData<TableRow[]>(manager, `/api/master/tables?outletId=${outletId}`)).find((x) => x.code === code);
  expect(t?.qrToken, `QR token for ${code}`).toBeTruthy();
  return { tableId: t!.id, token: t!.qrToken! };
}

async function guestPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); // no session cookie
  return { context, page: await context.newPage() };
}

const orderIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);

async function addDish(page: Page, name: string) {
  await page.getByRole("button", { name: `Add ${name}` }).click();
}

test.describe("QR guest transaction", () => {
  test("QR-001 guest order -> POS accept -> KOT/KDS -> guest pays online -> receipt -> stock -> sales", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token } = await qrToken(outlet.id, "F5");
    const manager = await apiAs("manager");
    const paneer = await materialByName(manager, "Paneer");
    const paneerBefore = await stockQty(manager, outlet.id, paneer.id);
    const salesBefore = await apiData<Summary>(manager, `/api/analytics/sales-summary?outletId=${outlet.id}`);

    // ---- GUEST: scan, browse, build a cart with a modifier, place the order.
    const guest = await guestPhone(browser);
    const g = guest.page;
    await g.goto(`/t/${token}`);
    await expect(g.getByLabel("Table F5")).toBeVisible();
    await expect(g.getByRole("heading", { level: 1 })).toBeVisible();
    await addDish(g, "Paneer Tikka");
    await addDish(g, "Paneer Tikka");
    await addDish(g, "Chicken Biryani");
    const mod = g.getByRole("dialog", { name: "Chicken Biryani" });
    await mod.getByRole("radio", { name: /Spicy/ }).click();
    await mod.getByRole("button", { name: /^Add/ }).click();
    await g.getByRole("button", { name: /3 items .* View cart/ }).click();
    const cart = g.getByRole("dialog", { name: "Your order" });
    await expect(cart.getByLabel("Estimated total")).toContainText(money(924)); // (2×280 + 320) × 1.05
    const placed = g.waitForResponse((r) => r.request().method() === "POST" && /\/api\/qr\/t\/.+\/orders$/.test(r.url()));
    await cart.getByRole("button", { name: "Place order" }).click();
    expect((await placed).status()).toBe(200);
    await g.waitForURL(/\/o\/[^/#]+#k=/);
    const orderId = orderIdFrom(g);
    await expect(g.getByTestId("order-stage")).toHaveText("Waiting for the restaurant to accept");

    // Server state: OPEN QR order at F5, priced by the server, no KOT yet.
    let o = await order(page.request, orderId);
    expect(o).toMatchObject({ status: "OPEN", channel: "QR", total: "924" });
    expect(o.items.find((i) => i.name === "Chicken Biryani")!.modifiers.map((m) => m.name)).toEqual(["Spice Level: Spicy"]);
    expect(o.kots).toHaveLength(0);

    // ---- POS: the incoming QR order is flagged; the cashier accepts it.
    await openPos(page);
    const openOrders = page.getByRole("button", { name: /^Open orders, \d+ new QR order/ });
    await expect(openOrders).toBeVisible({ timeout: 20_000 });
    await openOrders.click();
    const list = page.getByRole("dialog", { name: "Open orders" });
    await list.getByRole("button", { name: new RegExp(`#${orderId.slice(-6).toUpperCase()}.*Table F5.*New QR order`) }).click();
    await expect(page.getByText("QR · awaiting acceptance")).toBeVisible();
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    await expect(toast(page, `Order #${orderId.slice(-6).toUpperCase()} accepted and sent to kitchen`)).toBeVisible();
    o = await order(page.request, orderId);
    expect(o.status).toBe("SENT");
    expect(o.kots).toHaveLength(1);
    await expect(g.getByTestId("order-stage")).toHaveText("Sent to the kitchen", { timeout: 15_000 });

    // ---- KITCHEN: the KOT shows the table, items and modifier; Accept -> Start.
    const kitchen = await sessionFor(browser, "kitchen");
    const k = kitchen.page;
    await k.goto("/kitchen");
    const ticket = k.getByRole("article", { name: `KOT ${o.kots![0].number}, Table F5 · QR` });
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText("2 × Paneer Tikka");
    await expect(ticket).toContainText("Spice Level: Spicy");
    await ticket.getByRole("button", { name: "Accept" }).click();
    await ticket.getByRole("button", { name: "Start" }).click();
    await expect(ticket.getByRole("button", { name: "Ready" })).toBeVisible();
    expect((await order(page.request, orderId)).kots![0].status).toBe("PREPARING");
    await expect(g.getByTestId("order-stage")).toHaveText("Being prepared", { timeout: 15_000 });

    // ---- GUEST pays while the food cooks: a decline, then a successful retry.
    await g.getByRole("button", { name: /^Pay .*924\.00/ }).click();
    const gw = g.getByRole("region", { name: "Test payment gateway" });
    await expect(gw).toContainText(money(924));
    await gw.getByRole("button", { name: "Decline" }).click();
    await expect(g.getByRole("alert").filter({ hasText: "declined" })).toBeVisible();
    await g.getByRole("button", { name: /^Pay .*924\.00/ }).click();
    await g.getByRole("region", { name: "Test payment gateway" }).getByRole("button", { name: "Approve payment" }).click();
    await expect(g.getByText("Payment successful. Thank you!")).toBeVisible();
    await expect(g.getByTestId("bill-payment-status")).toHaveText("Paid");
    o = await order(page.request, orderId);
    expect(o.status).toBe("PAID");
    expect(o.payments!.map((p) => [p.method, p.status, Number(p.amount)]).sort()).toEqual([["ONLINE", "FAILED", 924], ["ONLINE", "SUCCESS", 924]]);

    // ---- KITCHEN finishes; the guest sees the order completed.
    await ticket.getByRole("button", { name: "Ready" }).click();
    await ticket.getByRole("button", { name: "Served" }).click();
    await expect(ticket).toHaveCount(0);
    await expect(g.getByTestId("order-stage")).toHaveText("Completed", { timeout: 15_000 });

    // ---- Receipt: guest copy == POS reprint, both from the server.
    const guestReceipt = await g.getByRole("article", { name: /^Receipt / }).innerText();
    expect(guestReceipt).toContain("Table F5");
    expect(guestReceipt).toContain(money(924));
    // Phase 4: the paid order carries its sequential invoice and CGST/SGST split (the
    // seeded outlet has a valid GSTIN), but the receipt never claims to be a tax invoice.
    expect(guestReceipt).toMatch(/Invoice [A-Z0-9]{1,4}\/\d{4}\/\d{5}/);
    expect(guestReceipt).toMatch(/CGST 2\.5%/);
    expect(guestReceipt).not.toMatch(/Tax invoice|TAX INVOICE|GST tax invoice/);
    await page.goto(`/pos/bill/${orderId}`);
    const staffReceipt = page.getByRole("article", { name: /^Receipt / });
    await expect(staffReceipt).toContainText("Paid");
    expect(await staffReceipt.innerText()).toBe(guestReceipt);
    await page.reload();
    expect(await page.getByRole("article", { name: /^Receipt / }).innerText()).toBe(guestReceipt); // reprint is identical

    // ---- Stock consumed once (2 × 0.2 kg paneer) and sales moved by exactly this order.
    expect(await stockQty(manager, outlet.id, paneer.id)).toBeCloseTo(paneerBefore - 0.4, 4);
    expect(await ledgerForOrder(manager, outlet.id, paneer.id, orderId)).toHaveLength(1);
    const salesAfter = await apiData<Summary>(manager, `/api/analytics/sales-summary?outletId=${outlet.id}`);
    expect(salesAfter.orders - salesBefore.orders).toBe(1);
    expect(salesAfter.revenue - salesBefore.revenue).toBeCloseTo(924, 2);

    await kitchen.context.close();
    await guest.context.close();
  });

  test("QR-002 prepaid guest order reaches the kitchen without staff; POS finds it under Recent with its receipt", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token } = await qrToken(outlet.id, "F6");
    const guest = await guestPhone(browser);
    const g = guest.page;
    await g.goto(`/t/${token}`);
    await addDish(g, "Masala Chai");
    await g.getByRole("button", { name: /1 item .* View cart/ }).click();
    await g.getByRole("dialog", { name: "Your order" }).getByRole("button", { name: "Place order" }).click();
    await g.waitForURL(/\/o\//);
    const orderId = orderIdFrom(g);
    await g.getByRole("button", { name: /^Pay/ }).click();
    await g.getByRole("region", { name: "Test payment gateway" }).getByRole("button", { name: "Approve payment" }).click();
    await expect(g.getByTestId("order-stage")).toHaveText("Sent to the kitchen");
    const o = await order(page.request, orderId);
    expect(o.status).toBe("PAID");
    expect(o.kots).toHaveLength(1); // sent by the verified payment, exactly once

    const kitchen = await sessionFor(browser, "kitchen");
    await kitchen.page.goto("/kitchen");
    await expect(kitchen.page.getByRole("article", { name: `KOT ${o.kots![0].number}, Table F6 · QR` })).toBeVisible();

    await openPos(page);
    await page.getByRole("button", { name: /^Open orders/ }).click();
    const list = page.getByRole("dialog", { name: "Open orders" });
    await list.getByRole("tab", { name: "Recent" }).click();
    const receipt = list.getByRole("link", { name: `Bill for order ${orderId.slice(-6).toUpperCase()}` });
    await expect(receipt).toHaveText("Receipt");
    await kitchen.context.close();
    await guest.context.close();
  });

  test("QR-003 invalid QR, tampering, cross-origin and a lost response during checkout never duplicate or misprice", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token, tableId } = await qrToken(outlet.id, "G8");
    const guest = await guestPhone(browser);
    const g = guest.page;

    await g.goto("/t/not-a-real-table-token");
    await expect(g.getByRole("heading", { name: "QR code not recognised" })).toBeVisible();

    const menu = await apiData<{ menu: Array<{ id: string; name: string }> }>(g.request, `/api/qr/t/${token}`);
    const chai = menu.menu.find((i) => i.name === "Masala Chai")!;
    const post = (body: unknown, headers: Record<string, string>) => g.request.post(`/api/qr/t/${token}/orders`, { data: body, headers });
    expect((await post({ items: [{ menuItemId: chai.id, qty: 1, unitPrice: 0.01 }] }, { "idempotency-key": "e2e-tamper-1", origin: baseUrl(g) })).status()).toBe(422);
    expect((await post({ items: [{ menuItemId: chai.id, qty: 1 }] }, { "idempotency-key": "e2e-xorigin-1", origin: "https://evil.example" })).status()).toBe(403);

    // The first submission reaches the server but its response is lost.
    await g.goto(`/t/${token}`);
    await addDish(g, "Masala Chai");
    await g.getByRole("button", { name: /View cart/ }).click();
    let dropped = false;
    await g.route("**/api/qr/t/*/orders", async (route) => {
      if (dropped) return route.continue();
      dropped = true;
      await route.fetch(); // the server creates the order…
      await route.abort("connectionreset"); // …the phone never hears back
    });
    await g.getByRole("button", { name: "Place order" }).click();
    await expect(g.getByRole("alert").filter({ hasText: /Network error/ })).toBeVisible();
    // The guest refreshes and taps again: the same cart replays the same order.
    await g.reload();
    await g.getByRole("button", { name: /View cart/ }).click();
    await g.getByRole("button", { name: "Place order" }).click();
    await g.waitForURL(/\/o\//);
    const mine = (await apiData<{ items: Array<{ id: string }> }>(page.request, `/api/orders?outletId=${outlet.id}&tableId=${tableId}&take=50`)).items;
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(orderIdFrom(g));
    expect((await order(page.request, mine[0].id)).total).toBe("42"); // 40 × 1.05, server-priced
    await guest.context.close();
  });
});

function baseUrl(p: Page) {
  return new URL(p.url()).origin;
}
