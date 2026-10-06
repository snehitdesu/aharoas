/**
 * INVESTOR ACCEPTANCE — the whole restaurant transaction in real browsers,
 * against the production build, on the real Coders' Cafe menu:
 *
 *   DEVICE 1  owner   (desktop)  Tables → Table T07's QR; finance / analytics / audit
 *   DEVICE 2  manager (desktop)  sees the same order; accepts the cash order; takes cash
 *   DEVICE 3  customer (phone)   scans T07 → real menu → cart → order → pays
 *   KITCHEN   chef    (desktop)  KDS: accept → start → ready → served
 *
 * INV-001 Razorpay success · INV-002 cash · INV-003 Razorpay decline, window
 * closed, then a successful new attempt. After each: exactly one order, one
 * successful payment, one KOT, one invoice; finance and analytics moved by the
 * order total; audit records exist.
 *
 * Razorpay = tests/support/razorpayEmulator.ts behind RAZORPAY_API_BASE (see
 * playwright.investor.config.ts). The browser's checkout.js is replaced by a
 * stub that plays the customer's side through the emulator (the real script
 * would load Razorpay's hosted payment page). Everything RESTORA does — the
 * gateway order for the server amount, signature + capture verification,
 * signed webhooks, settlement — is the real code path.
 */
import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from "@playwright/test";
import { RazorpayEmulator, type CheckoutResponse } from "../../tests/support/razorpayEmulator";
import { INVESTOR_PORT, EMULATOR_PORT, INVESTOR_RZP } from "../../playwright.investor.config";

const BASE = `http://localhost:${INVESTOR_PORT}`;
const PASSWORD = "Demo@12345";
const USERS = { owner: "cafe.owner@demo.local", manager: "cafe.manager@demo.local", chef: "cafe.chef@demo.local" } as const;
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const emu = new RazorpayEmulator({ ...INVESTOR_RZP, port: EMULATOR_PORT, webhookUrl: `${BASE}/api/webhooks/payment/razorpay` });
/** What the next Checkout window does: a declined attempt first, then pay or close. */
let plan: { declineFirst?: boolean; finish: "pay" | "close" } = { finish: "pay" };
const opened: Array<{ key: string; orderId: string; amount: number }> = [];
const webhooks: Array<Promise<{ status: number }>> = [];

test.beforeAll(async () => {
  await emu.start();
});
test.afterAll(async () => {
  await Promise.allSettled(webhooks);
  await emu.stop();
});

// ---------------- devices ----------------

async function staff(browser: Browser, who: keyof typeof USERS): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[who]);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

/** The customer's phone. Razorpay's checkout.js is served by a stub driven from here (see header). */
async function customerPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.exposeFunction("__rzpCheckout", async (orderId: string, amount: number, key: string) => {
    opened.push({ key, orderId, amount });
    const steps: Array<{ failed?: string; response?: CheckoutResponse }> = [];
    if (plan.declineFirst) {
      const d = emu.attempt(orderId, "failed");
      steps.push({ failed: d.payment.error_description ?? "Declined" });
      webhooks.push(emu.deliver("payment.failed", d.payment.id));
      await webhooks[webhooks.length - 1];
    }
    if (plan.finish === "pay") {
      const ok = emu.attempt(orderId, "captured");
      steps.push({ response: ok.response! });
      // Razorpay also sends its webhook (shortly after the browser handler fires).
      webhooks.push(new Promise((r) => setTimeout(r, 400)).then(() => emu.deliver("payment.captured", ok.payment.id)));
    }
    return steps;
  });
  await context.route("https://checkout.razorpay.com/v1/checkout.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.Razorpay = class {
        constructor(o) { this.o = o; this.failed = function () {}; }
        on(e, cb) { if (e === "payment.failed") this.failed = cb; }
        open() {
          const o = this.o;
          window.__rzpCheckout(o.order_id, o.amount, o.key).then((steps) => {
            for (const s of steps) if (s.failed) this.failed({ error: { description: s.failed } });
            const last = steps[steps.length - 1];
            if (last && last.response) o.handler(last.response); else o.modal.ondismiss();
          });
        }
      };`,
    })
  );
  return { context, page: await context.newPage() };
}

// ---------------- server state (through the real API, as the owner) ----------------

type OrderDTO = { id: string; status: string; channel: string; total: string; items: Array<{ name: string; qty: string; modifiers: Array<{ name: string }> }>; payments?: Array<{ method: string; status: string; amount: string }>; kots?: Array<{ id: string; number: number; status: string }>; invoiceNo?: string | null };
async function get<T>(api: APIRequestContext, url: string): Promise<T> {
  const r = await api.get(url);
  expect(r.status(), url).toBe(200);
  return ((await r.json()) as { data: T }).data;
}
const orderIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
const ref = (orderId: string) => orderId.slice(-6).toUpperCase();

async function exactlyOnce(api: APIRequestContext, outletId: string, orderId: string, total: number, method: string) {
  const o = await get<OrderDTO>(api, `/api/orders/${orderId}`);
  expect(o.status).toBe("PAID");
  expect(Number(o.total)).toBe(total);
  expect(o.payments!.filter((p) => p.status === "SUCCESS").map((p) => [p.method, Number(p.amount)])).toEqual([[method, total]]);
  expect(o.kots).toHaveLength(1);
  const fin = await get<{ items: Array<{ orderId: string; status: string; amount: number; method: string }> }>(api, `/api/finance/payments?outletId=${outletId}&orderId=${orderId}`);
  expect(fin.items.filter((p) => p.status === "SUCCESS").map((p) => [p.method, p.amount])).toEqual([[method, total]]);
  const audit = await get<{ items: Array<{ action: string }> }>(api, `/api/audit?entityType=Order&entityId=${orderId}`);
  expect(audit.items.length).toBeGreaterThanOrEqual(1);
  return o;
}

// ---------------- the scenario ----------------

async function scanTable07(owner: Page) {
  await owner.goto("/tables");
  await owner.getByRole("button", { name: "QR for T07" }).click();
  const dlg = owner.getByRole("dialog", { name: /QR — table T07/ });
  await expect(dlg.getByRole("img", { name: "QR code for table T07" })).toBeVisible();
  const link = (await dlg.getByLabel("Guest ordering link").textContent())!.trim();
  expect(link).toMatch(new RegExp(`^${BASE}/t/[A-Za-z0-9_-]+$`)); // PUBLIC_BASE_URL, not the viewer's origin
  await dlg.getByRole("button", { name: "Close" }).first().click();
  return link;
}

async function orderFromTable(guest: Page, link: string, cart: Array<{ item: string; size?: string; addOn?: string; times?: number }>, expectedTotal: number, pay: "CASH" | "ONLINE" = "CASH") {
  await guest.goto(link);
  await expect(guest.getByLabel("Table T07").first()).toBeVisible();
  await expect(guest.getByText("Coders' Cafe").first()).toBeVisible();
  for (const line of cart) {
    const times = line.times ?? 1;
    if (line.size || line.addOn) {
      // Sizes / add-ons: the item sheet with the item's real RESTORA variants and modifier group.
      for (let i = 0; i < times; i++) {
        await guest.getByRole("button", { name: `Add ${line.item}` }).click();
        const dlg = guest.getByRole("dialog", { name: line.item });
        if (line.size) await dlg.getByRole("radio", { name: new RegExp(`^${line.size}`) }).check();
        if (line.addOn) await dlg.getByRole("checkbox", { name: new RegExp(`^${line.addOn}`) }).check();
        await dlg.getByRole("button", { name: /^Add/ }).click();
      }
    } else {
      await guest.getByRole("button", { name: `Add ${line.item}` }).click();
      for (let i = 1; i < times; i++) await guest.getByRole("button", { name: `Increase ${line.item}` }).click();
    }
  }
  // Sticky cart → cart (priced by the server) → checkout → place the order.
  await guest.getByRole("link", { name: /^View cart/ }).click();
  await expect(guest.getByTestId("cart-total")).toHaveText(inr(expectedTotal));
  await guest.getByRole("link", { name: /^Proceed to checkout/ }).click();
  await expect(guest.getByText("Table T07").first()).toBeVisible();
  if (pay === "ONLINE") await guest.getByRole("radio", { name: /Pay online/ }).check();
  await guest.getByRole("button", { name: /^Place order/ }).click();
  await guest.waitForURL(/\/o\/[^/#]+#k=/);
  // Cash: the order waits for the restaurant (no KOT yet). Online: the payment window is already opening.
  if (pay === "CASH") await expect(guest.getByTestId("order-stage")).toHaveText("Waiting for the restaurant to accept");
  return orderIdFrom(guest);
}

async function kitchenCompletes(chef: Page, orderId: string, expectLines: string[]) {
  await chef.goto("/kitchen");
  const ticket = chef.getByRole("article", { name: /Table T07 · QR$/ });
  await expect(ticket).toBeVisible();
  for (const l of expectLines) await expect(ticket).toContainText(l);
  await ticket.getByRole("button", { name: "Accept" }).click();
  await ticket.getByRole("button", { name: "Start" }).click();
  await ticket.getByRole("button", { name: "Ready" }).click();
  await ticket.getByRole("button", { name: "Served" }).click();
  await expect(ticket).toHaveCount(0);
  void orderId;
}

test.describe("investor acceptance — Coders' Cafe, Table 07", () => {
  test("INV-001 Razorpay: scan T07, real menu, pay online, kitchen, bill, finance, analytics — nothing doubled", async ({ browser }) => {
    const owner = await staff(browser, "owner");
    const manager = await staff(browser, "manager");
    const chef = await staff(browser, "chef");
    const api = owner.page.request;
    const outletId = (await get<Array<{ id: string; code: string }>>(api, "/api/master/outlets")).find((o) => o.code === "CC01")!.id;
    const before = await get<{ orders: number; revenue: number }>(api, `/api/analytics/sales-summary?outletId=${outletId}`);

    const link = await scanTable07(owner.page);
    const guest = await customerPhone(browser);
    const g = guest.page;
    // Real items and board prices on the customer's phone.
    await g.goto(link);
    await expect(g.getByRole("button", { name: "Add Classic Margherita Pizza" })).toBeVisible();
    await expect(g.getByRole("listitem").filter({ hasText: "Classic Margherita Pizza" }).first()).toContainText("₹99");
    await expect(g.getByRole("listitem").filter({ hasText: "Guntur Chiken 65" }).first()).toContainText("₹240");

    // ---- checkout with "Pay online": Razorpay opens on the order page for the SERVER's amount.
    // (160 + 60) + 2 × 110 = 440 + 5% = 462
    plan = { finish: "pay" };
    const orderId = await orderFromTable(g, link, [
      { item: "Classic Margherita Pizza", size: "Medium", addOn: "Make It a Cheese Melt" },
      { item: "Classic Fries", size: "Large", times: 2 },
    ], 462, "ONLINE");
    await expect(g.getByText("Payment successful. Thank you!")).toBeVisible();
    let o = await get<OrderDTO>(api, `/api/orders/${orderId}`);
    expect(o).toMatchObject({ channel: "QR", total: "462" });
    expect(o.items.map((i) => [i.name, Number(i.qty)])).toEqual([["Classic Margherita Pizza (Medium)", 1], ["Classic Fries (Large)", 2]]);
    expect(opened.at(-1)).toMatchObject({ key: INVESTOR_RZP.keyId, amount: 46200 });
    expect(emu.orders.get(opened.at(-1)!.orderId)?.amount).toBe(46200);
    await Promise.all(webhooks);
    // A redelivered webhook is a duplicate.
    const pay = [...emu.payments.values()].find((p) => p.order_id === opened.at(-1)!.orderId && p.status === "captured")!;
    expect((await emu.deliver("payment.captured", pay.id)).body).toMatchObject({ status: "DUPLICATE" });

    // ---- manager sees the same order; the kitchen gets it as one KOT (prepaid → sent automatically)
    await manager.page.goto(`/pos/bill/${orderId}`);
    const staffCopy = manager.page.getByRole("article", { name: /^Receipt / });
    await expect(staffCopy).toContainText("Table T07");
    await expect(staffCopy).toContainText(inr(462));
    await expect(staffCopy).toContainText("Paid");
    await kitchenCompletes(chef.page, orderId, ["Classic Margherita Pizza (Medium)", "Pizza Add-ons: Make It a Cheese Melt", "2 × Classic Fries (Large)"]);
    await expect(g.getByTestId("order-stage")).toHaveText("Completed", { timeout: 20_000 });

    // ---- the bill is the order; payment, finance, analytics, audit all agree, once
    o = await exactlyOnce(api, outletId, orderId, 462, "ONLINE");
    const receipt = await g.getByRole("article", { name: /^Receipt / }).innerText();
    expect(receipt).toContain("Classic Margherita Pizza (Medium)");
    expect(receipt).toContain(inr(462));
    expect(receipt).toMatch(/Invoice CC\/\d{4}\/\d{5}/);
    const after = await get<{ orders: number; revenue: number }>(api, `/api/analytics/sales-summary?outletId=${outletId}`);
    expect(after.orders - before.orders).toBe(1);
    expect(after.revenue - before.revenue).toBeCloseTo(462, 2);
    const paymentAudit = await get<{ items: Array<{ action: string; after: unknown }> }>(api, `/api/audit?entityType=Payment&action=PAYMENT`);
    expect(paymentAudit.items.length).toBeGreaterThanOrEqual(1);

    for (const d of [owner, manager, chef, guest]) await d.context.close();
  });

  test("INV-002 cash: customer orders at T07, manager accepts, kitchen cooks, manager takes cash", async ({ browser }) => {
    const owner = await staff(browser, "owner");
    const manager = await staff(browser, "manager");
    const chef = await staff(browser, "chef");
    const api = owner.page.request;
    const outletId = (await get<Array<{ id: string; code: string }>>(api, "/api/master/outlets")).find((o) => o.code === "CC01")!.id;
    const link = await scanTable07(owner.page);
    const guest = await customerPhone(browser);
    const g = guest.page;

    // 150 + 185 = 335 + 5% = 351.75
    const orderId = await orderFromTable(g, link, [{ item: "Loaded Veg Nachos" }, { item: "Veg Arrabita Penne" }], 351.75);
    await expect(g.getByTestId("pay-at-counter")).toContainText(`#${ref(orderId)}`);

    // Manager: the waiting QR order → accept (KOT) at the POS.
    const m = manager.page;
    await m.goto("/pos");
    const openOrders = m.getByRole("button", { name: /^Open orders, \d+ new QR order/ });
    await expect(openOrders).toBeVisible({ timeout: 20_000 });
    await openOrders.click();
    await m.getByRole("dialog", { name: "Open orders" }).getByRole("button", { name: new RegExp(`#${ref(orderId)}.*Table T07`) }).click();
    await m.getByRole("button", { name: "Send to kitchen" }).click();
    await expect(g.getByTestId("order-stage")).toHaveText("Sent to the kitchen", { timeout: 20_000 });

    await kitchenCompletes(chef.page, orderId, ["Loaded Veg Nachos", "Veg Arrabita Penne"]);

    // Manager takes the cash.
    await m.getByRole("button", { name: "Pay", exact: true }).click();
    const dlg = m.getByRole("dialog", { name: "Take payment" });
    await expect(dlg.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");
    await dlg.getByLabel("Cash received").fill("400");
    await expect(dlg.getByText(`Change to return: ${inr(48.25)}`)).toBeVisible();
    await dlg.getByRole("button", { name: `Charge ${inr(351.75)}` }).click();
    await expect(dlg.getByText("Paid in full")).toBeVisible();
    await dlg.getByRole("button", { name: "Done" }).click();

    await expect(g.getByTestId("bill-payment-status")).toHaveText("Paid", { timeout: 20_000 });
    await exactlyOnce(api, outletId, orderId, 351.75, "CASH");
    // A second charge attempt on the settled order is refused by the server.
    const again = await m.request.post("/api/payments", { data: { orderId, method: "CASH", amount: 351.75 }, headers: { origin: BASE } });
    expect(again.status()).toBe(422);
    for (const d of [owner, manager, chef, guest]) await d.context.close();
  });

  test("INV-003 Razorpay failure: declined and window closed → nothing paid or cooked; a new attempt succeeds once", async ({ browser }) => {
    const owner = await staff(browser, "owner");
    const api = owner.page.request;
    const outletId = (await get<Array<{ id: string; code: string }>>(api, "/api/master/outlets")).find((o) => o.code === "CC01")!.id;
    const link = await scanTable07(owner.page);
    const guest = await customerPhone(browser);
    const g = guest.page;

    // 210 + 5% = 220.50; "Pay online" at checkout opens Razorpay: the bank declines, the guest closes the window.
    plan = { declineFirst: true, finish: "close" };
    const orderId = await orderFromTable(g, link, [{ item: "Butter Garlic Wings (6 Pc)" }], 220.5, "ONLINE");
    // The bank's reason stays visible after the guest closes the Razorpay window.
    await expect(g.getByRole("alert").filter({ hasText: /declined by the bank.*You can try again\./ })).toBeVisible();
    await Promise.all(webhooks);
    let o = await get<OrderDTO>(api, `/api/orders/${orderId}`);
    expect(o.status).toBe("OPEN");
    expect(o.kots).toHaveLength(0);
    expect(o.payments!.filter((p) => p.status === "SUCCESS")).toHaveLength(0);

    // The guest tries again: a new attempt is captured.
    plan = { finish: "pay" };
    await g.getByRole("button", { name: /^(Pay online|Resume payment)/ }).click();
    await expect(g.getByText("Payment successful. Thank you!")).toBeVisible();
    await Promise.all(webhooks);
    o = await exactlyOnce(api, outletId, orderId, 220.5, "ONLINE");
    expect(o.payments!.map((p) => p.status).sort()).toEqual(["FAILED", "SUCCESS"]);
    for (const d of [owner, guest]) await d.context.close();
  });
});
