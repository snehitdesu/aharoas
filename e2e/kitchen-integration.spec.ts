/**
 * Customer website → RESTORA → KOT → kitchen, proven against the database:
 *
 *   CK-001 ONLINE chosen at checkout: storefront → test gateway "Approve" →
 *          server verification (payment.verifyPayment) → order confirmed →
 *          exactly one KOT → the chef's KDS shows it → Accept / Start / Ready /
 *          Served → the customer's status follows. A replayed confirmation
 *          changes nothing (one order, one payment, one KOT).
 *   CK-002 CASH chosen at checkout: the order waits for the restaurant (no KOT,
 *          nothing on the KDS) → the cashier accepts it at the POS → one KOT →
 *          chef → served → cash at the POS → paid once.
 *
 * Every record is read back from the database and must point at the same
 * order, organization, outlet and table that the QR token resolves to, and
 * the KITCHEN user's outlet must be that outlet. (The KOT is RESTORA's kitchen
 * ticket: the KDS lists live KOTs; there is no separate ticket table.)
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { statePath, outletByCode, openPos, toast, sessionFor, apiAs, apiData, e2eDb, CENTRAL, ROLES } from "./helpers";

test.use({ storageState: statePath("cashier") });
const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3210)}`;

type TableRow = { id: string; code: string; qrToken: string | null };

async function qrTable(outletId: string, code: string) {
  const manager = await apiAs("manager");
  const t = (await apiData<TableRow[]>(manager, `/api/master/tables?outletId=${outletId}`)).find((x) => x.code === code);
  expect(t?.qrToken, `QR token for ${code}`).toBeTruthy();
  return { tableId: t!.id, token: t!.qrToken! };
}

async function guestPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return { context, page: await context.newPage() };
}

/** Storefront: menu → cart page → checkout → place the order with the chosen payment method. */
async function order(g: Page, token: string, dish: string, method: "CASH" | "ONLINE") {
  await g.goto(`/t/${token}`);
  await g.getByRole("button", { name: `Add ${dish}` }).click();
  await g.getByRole("link", { name: /^View cart/ }).click();
  await g.waitForURL(/\/cart$/);
  await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
  await g.waitForURL(/\/checkout$/);
  await g.getByRole("radio", { name: method === "ONLINE" ? /Pay online/ : /^Cash/ }).check();
  await g.getByRole("button", { name: /^Place order/ }).click();
  await g.waitForURL(/\/o\/[^/#]+#k=/);
  const url = new URL(g.url());
  return { orderId: decodeURIComponent(url.pathname.split("/").pop()!), key: new URLSearchParams(url.hash.slice(1)).get("k")! };
}

/** The records behind one order, straight from the database. */
async function records(orderId: string) {
  const db = await e2eDb();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, items: true, kots: { include: { items: true, station: true } }, table: true } });
    return o;
  } finally {
    await db.$disconnect();
  }
}

async function chefOutlet() {
  const db = await e2eDb();
  try {
    const u = await db.user.findUniqueOrThrow({ where: { email: ROLES.kitchen }, include: { memberships: true } });
    return { organizationId: u.organizationId, outletIds: u.memberships.map((m) => m.outletId) };
  } finally {
    await db.$disconnect();
  }
}

async function chefCooks(k: Page, kotNumber: number, table: string, guest: Page) {
  await k.goto("/kitchen");
  const ticket = k.getByRole("article", { name: `KOT ${kotNumber}, Table ${table} · QR` });
  await expect(ticket).toBeVisible();
  await ticket.getByRole("button", { name: "Accept" }).click();
  await ticket.getByRole("button", { name: "Start" }).click();
  await expect(guest.getByTestId("order-stage")).toHaveText("Being prepared", { timeout: 15_000 });
  await ticket.getByRole("button", { name: "Ready" }).click();
  await expect(guest.getByTestId("order-stage")).toHaveText("Ready", { timeout: 15_000 });
  await ticket.getByRole("button", { name: "Served" }).click();
  await expect(ticket).toHaveCount(0);
  await expect(guest.getByTestId("order-stage")).toHaveText(/Served|Completed/, { timeout: 15_000 });
}

test.describe("customer website → order → payment → KOT → kitchen", () => {
  test("CK-001 online: test gateway Approve → server verification → one KOT → chef → served; a replayed confirmation changes nothing", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { tableId, token } = await qrTable(outlet.id, "F6");
    const guest = await guestPhone(browser);
    const g = guest.page;
    const { orderId, key } = await order(g, token, "Masala Chai", "ONLINE");

    // Before the gateway answers, nothing reaches the kitchen.
    let o = await records(orderId);
    expect(o.status).toBe("OPEN");
    expect(o.kots).toHaveLength(0);

    // The checkout opened the test gateway for the server's amount; Approve goes to the server.
    const gw = g.getByRole("region", { name: "Test payment gateway" });
    await expect(gw).toBeVisible();
    const confirmCall = g.waitForResponse((r) => r.request().method() === "POST" && /\/payments\/confirm$/.test(r.url()));
    await gw.getByRole("button", { name: "Approve payment" }).click();
    expect((await confirmCall).status()).toBe(200);
    await expect(g.getByTestId("order-stage")).toHaveText("Sent to the kitchen", { timeout: 15_000 });

    o = await records(orderId);
    const chef = await chefOutlet();
    // ORDER / PAYMENT / KOT: one of each, all on this order, in the QR token's tenant.
    expect(o).toMatchObject({ status: "PAID", source: "QR", tableId, outletId: outlet.id });
    expect(o.organizationId).toBe(chef.organizationId);
    expect(chef.outletIds).toContain(o.outletId);
    expect(o.payments).toHaveLength(1);
    expect(o.payments[0]).toMatchObject({ orderId, method: "ONLINE", provider: "mock", status: "SUCCESS", outletId: o.outletId, organizationId: o.organizationId });
    expect(o.payments[0].providerRef).toBeTruthy();
    expect(o.payments[0].verifiedAt).toBeTruthy();
    expect(o.kots).toHaveLength(1);
    expect(o.kots[0]).toMatchObject({ orderId, status: "NEW", outletId: o.outletId, organizationId: o.organizationId });
    expect(o.kots[0].station?.name).toBe(o.items[0].station); // routed to the item's own station (Masala Chai = BAR)
    expect(o.kots[0].items.map((i) => i.name)).toEqual(["Masala Chai"]);
    expect(o.invoiceNo).toBeTruthy();
    test.info().annotations.push({ type: "records", description: `order ${o.id} org ${o.organizationId} outlet ${o.outletId} table ${o.table?.code} ${o.status} | payment ${o.payments[0].id} ${o.payments[0].method} ${o.payments[0].status} ref ${o.payments[0].providerRef} | KOT ${o.kots[0].id} #${o.kots[0].number} ${o.kots[0].station?.name} ${o.kots[0].status}` });

    // The same confirmation again (double tap / retried request): nothing doubles.
    const replay = await page.request.post(`/api/qr/orders/${encodeURIComponent(orderId)}/payments/confirm`, {
      headers: { "x-order-key": key, origin: BASE },
      data: { paymentId: o.payments[0].id },
    });
    expect(replay.status()).toBe(200);
    const again = await records(orderId);
    expect(again.payments.filter((p) => p.status === "SUCCESS")).toHaveLength(1);
    expect(again.kots).toHaveLength(1);
    expect(again.status).toBe("PAID");

    // The chef's KDS query returns it; the chef cooks it; the customer's page follows.
    const kitchen = await sessionFor(browser, "kitchen");
    await chefCooks(kitchen.page, o.kots[0].number, "F6", g);
    expect((await records(orderId)).kots.map((k) => k.status)).toEqual(["SERVED"]);
    await kitchen.context.close();
    await guest.context.close();
  });

  test("CK-002 cash: waits for the restaurant (no KOT) → POS accepts → one KOT → chef → served → cash taken once", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { tableId, token } = await qrTable(outlet.id, "F5");
    const guest = await guestPhone(browser);
    const g = guest.page;
    const { orderId } = await order(g, token, "Masala Chai", "CASH");
    await expect(g.getByTestId("order-stage")).toHaveText("Waiting for the restaurant to accept");

    // Not accepted yet: no KOT, and the chef's KDS does not list it.
    let o = await records(orderId);
    expect(o).toMatchObject({ status: "OPEN", source: "QR", tableId, outletId: outlet.id });
    expect(o.payments).toHaveLength(0);
    expect(o.kots).toHaveLength(0);
    const kitchen = await sessionFor(browser, "kitchen");
    await kitchen.page.goto("/kitchen");
    await expect(kitchen.page.getByRole("article", { name: /Table F5 · QR$/ })).toHaveCount(0);

    // The cashier accepts it at the POS → the existing submitOrder → one KOT.
    await openPos(page);
    const openOrders = page.getByRole("button", { name: /^Open orders, \d+ new QR order/ });
    await expect(openOrders).toBeVisible({ timeout: 20_000 });
    await openOrders.click();
    await page.getByRole("dialog", { name: "Open orders" }).getByRole("button", { name: new RegExp(`#${orderId.slice(-6).toUpperCase()}.*Table F5.*New QR order`) }).click();
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    await expect(toast(page, `Order #${orderId.slice(-6).toUpperCase()} accepted and sent to kitchen`)).toBeVisible();
    await expect(g.getByTestId("order-stage")).toHaveText("Sent to the kitchen", { timeout: 15_000 });
    o = await records(orderId);
    expect(o.status).toBe("SENT");
    expect(o.kots).toHaveLength(1);
    expect(o.kots[0]).toMatchObject({ orderId, status: "NEW", outletId: o.outletId });

    await chefCooks(kitchen.page, o.kots[0].number, "F5", g);

    // Cash at the counter, once.
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    const pay = page.getByRole("dialog", { name: "Take payment" });
    await pay.getByLabel("Cash received").fill(String(Number(o.total)));
    await pay.getByRole("button", { name: /^Charge / }).click();
    await expect(pay.getByText("Paid in full")).toBeVisible();
    await pay.getByRole("button", { name: "Done" }).click();
    await expect(g.getByTestId("bill-payment-status")).toHaveText("Paid", { timeout: 15_000 });
    o = await records(orderId);
    expect(o.status).toBe("PAID");
    expect(o.payments.map((p) => [p.method, p.status])).toEqual([["CASH", "SUCCESS"]]);
    expect(o.kots.map((k) => k.status)).toEqual(["SERVED"]);
    test.info().annotations.push({ type: "records", description: `order ${o.id} ${o.status} | payment ${o.payments[0].id} CASH SUCCESS | KOT ${o.kots[0].id} #${o.kots[0].number} ${o.kots[0].status}` });
    await kitchen.context.close();
    await guest.context.close();
  });
});
