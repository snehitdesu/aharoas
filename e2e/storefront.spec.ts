/**
 * Customer storefront (table QR website) in real phone-sized browsers against
 * the production build and the real database:
 *
 *   SF-001 the three target phones (390 / 393 / 430 wide): home → menu → item
 *          sheet → cart → checkout without horizontal scrolling; sticky cart.
 *   SF-002 the café changes a price and sells out an item while it sits in a
 *          guest's cart: the cart shows the server's price, blocks checkout
 *          until the unavailable item is removed, and the order is server-priced.
 *   SF-003 two guests at the same table: separate carts, separate orders, each
 *          sees only their own; "My orders" lists only this phone's orders.
 *   SF-004 a double tap on "Place order" creates one order; opening hours close
 *          ordering (browsing still works); a disabled QR fails safely.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { statePath, outletByCode, apiAs, apiData, apiCall, order, e2eDb, CENTRAL, money } from "./helpers";

test.use({ storageState: statePath("cashier") });

type TableRow = { id: string; code: string; qrToken: string | null };
type MenuRow = { id: string; name: string };

async function tableToken(outletId: string, code: string) {
  const manager = await apiAs("manager");
  const t = (await apiData<TableRow[]>(manager, `/api/master/tables?outletId=${outletId}`)).find((x) => x.code === code);
  expect(t?.qrToken, `QR token for ${code}`).toBeTruthy();
  return { tableId: t!.id, token: t!.qrToken! };
}

async function phone(browser: Browser, width = 390, height = 844) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  return { context, page: await context.newPage() };
}

const noSideScroll = async (p: Page, where: string) => expect(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `horizontal overflow on ${where}`).toBeLessThanOrEqual(0);

test.describe("customer storefront", () => {
  test("SF-001 phones 390 / 393 / 430: home → menu → item → cart → checkout, no side-scrolling, sticky cart", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token } = await tableToken(outlet.id, "F2");
    for (const [w, h] of [[390, 844], [393, 852], [430, 932]]) {
      const guest = await phone(browser, w, h);
      const g = guest.page;
      await g.goto(`/t/${token}`);
      await expect(g.getByRole("heading", { level: 1 })).toBeVisible(); // short branded landing
      await expect(g.getByLabel("Table F2").first()).toBeVisible();
      await expect(g.getByRole("button", { name: "Order now" })).toBeVisible();
      await noSideScroll(g, `home @${w}`);
      await g.getByRole("button", { name: "Order now" }).click();
      await expect(g.getByRole("navigation", { name: "Menu categories" })).toBeVisible();

      await g.getByRole("button", { name: "Add Chicken Biryani" }).click();
      const sheet = g.getByRole("dialog", { name: "Chicken Biryani" });
      await expect(sheet).toBeVisible();
      await noSideScroll(g, `item sheet @${w}`);
      await sheet.getByRole("radio", { name: /Medium/ }).check();
      await sheet.getByRole("button", { name: /^Add to cart/ }).click();
      await expect(sheet).toBeHidden();

      // Scroll far down the menu: the cart is still one tap away.
      await g.mouse.wheel(0, 4000);
      const bar = g.getByRole("link", { name: /^View cart: 1 item/ });
      await expect(bar).toBeInViewport();
      const box = (await bar.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44); // touch target
      await bar.click();
      await expect(g.getByRole("heading", { name: "Your order" })).toBeVisible();
      await expect(g.getByText("Prices and GST confirmed by the café just now.")).toBeVisible();
      await noSideScroll(g, `cart @${w}`);
      await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
      await expect(g.getByRole("heading", { name: "Checkout" })).toBeVisible();
      await expect(g.getByRole("radio", { name: /Cash/ })).toBeChecked();
      await noSideScroll(g, `checkout @${w}`);
      await guest.context.close();
    }
  });

  test("SF-002 price change + sold out while in the cart: server price shown, checkout blocked until removed, order server-priced", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token } = await tableToken(outlet.id, "F3");
    const manager = await apiAs("manager");
    const menu = await apiData<MenuRow[]>(manager, `/api/menu?outletId=${outlet.id}&activeOnly=true`);
    const chai = menu.find((m) => m.name === "Masala Chai")!;
    const tikka = menu.find((m) => m.name === "Paneer Tikka")!;
    const guest = await phone(browser);
    const g = guest.page;
    try {
      await g.goto(`/t/${token}`);
      await g.getByRole("button", { name: "Add Masala Chai" }).click();
      await g.getByRole("button", { name: "Add Paneer Tikka" }).click();
      await g.getByRole("link", { name: /^View cart/ }).click();
      await expect(g.getByTestId("cart-total")).toHaveText(money(336)); // (40 + 280) × 1.05

      // The café changes the chai price and runs out of paneer tikka at this outlet.
      expect((await apiCall(manager, "POST", `/api/menu/outlets/${outlet.id}/items/${chai.id}`, { price: 45 })).status).toBe(200);
      expect((await apiCall(manager, "POST", `/api/menu/outlets/${outlet.id}/items/${tikka.id}`, { soldOut: true })).status).toBe(200);
      await g.reload();
      await expect(g.getByText(/The café changed the price of Masala Chai/)).toBeVisible();
      await expect(g.getByRole("alert").filter({ hasText: "isn't available" })).toBeVisible();
      await expect(g.getByText(/Paneer Tikka is sold out/)).toBeVisible();
      await expect(g.getByRole("button", { name: "Remove unavailable items to continue" })).toBeDisabled();

      await g.getByRole("button", { name: "Remove Paneer Tikka" }).click();
      await expect(g.getByTestId("cart-total")).toHaveText(money(47.25)); // 45 × 1.05, from the server
      await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
      await g.getByRole("button", { name: "Place order" }).click();
      await g.waitForURL(/\/o\/[^/#]+#k=/);
      const id = decodeURIComponent(new URL(g.url()).pathname.split("/").pop()!);
      expect((await order(page.request, id)).total).toBe("47.25");
      await expect(g.getByRole("heading", { name: "Order received" })).toBeVisible();
    } finally {
      await apiCall(manager, "POST", `/api/menu/outlets/${outlet.id}/items/${chai.id}`, { price: null });
      await apiCall(manager, "POST", `/api/menu/outlets/${outlet.id}/items/${tikka.id}`, { soldOut: false });
      await guest.context.close();
    }
  });

  test("SF-003 two guests at one table: separate carts and orders; each phone sees only its own", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token, tableId } = await tableToken(outlet.id, "F4");
    const a = await phone(browser);
    const b = await phone(browser, 430, 932);

    await a.page.goto(`/t/${token}`);
    await b.page.goto(`/t/${token}`);
    await a.page.getByRole("button", { name: "Add Masala Chai" }).click();
    await b.page.getByRole("button", { name: "Add Paneer Tikka" }).click();
    await expect(a.page.getByRole("link", { name: /^View cart: 1 item, ₹42\.00/ })).toBeVisible(); // A's cart only
    await expect(b.page.getByRole("link", { name: /^View cart: 1 item, ₹294\.00/ })).toBeVisible();

    const place = async (p: Page, name: string) => {
      await p.getByRole("link", { name: /^View cart/ }).click();
      await p.getByRole("link", { name: /^Proceed to checkout/ }).click();
      await p.getByLabel(/Your name/).fill(name);
      await p.getByRole("button", { name: "Place order" }).click();
      await p.waitForURL(/\/o\/[^/#]+#k=/);
      return decodeURIComponent(new URL(p.url()).pathname.split("/").pop()!);
    };
    const idA = await place(a.page, "Guest A");
    const idB = await place(b.page, "Guest B");
    expect(idA).not.toBe(idB);
    await expect(a.page.getByRole("article", { name: /^Bill / })).toContainText("Masala Chai");
    await expect(a.page.getByRole("article", { name: /^Bill / })).not.toContainText("Paneer Tikka");
    await expect(b.page.getByRole("article", { name: /^Bill / })).toContainText("Paneer Tikka");

    // A's link without A's key, or B's order with A's key: nothing.
    const keyA = new URLSearchParams(new URL(a.page.url()).hash.slice(1)).get("k")!;
    const peek = await a.page.request.get(`/api/qr/orders/${idB}`, { headers: { "x-order-key": keyA } });
    expect(peek.status()).toBe(404);
    const c = await phone(browser);
    await c.page.goto(`/o/${idA}`);
    await expect(c.page.getByRole("heading", { name: "Order link incomplete" })).toBeVisible();

    // "My orders" on A's phone lists A's order only.
    await a.page.goto(`/t/${token}`);
    await a.page.getByRole("button", { name: /^My orders \(1\)/ }).click();
    const mine = a.page.getByRole("dialog", { name: "My orders" });
    await expect(mine.getByRole("link")).toHaveCount(1);
    await expect(mine).toContainText(`#${idA.slice(-6).toUpperCase()}`);

    const onTable = (await apiData<{ items: Array<{ id: string }> }>(page.request, `/api/orders?outletId=${outlet.id}&tableId=${tableId}&take=50`)).items.map((o) => o.id);
    expect(onTable).toEqual(expect.arrayContaining([idA, idB]));
    for (const d of [a, b, c]) await d.context.close();
  });

  test("SF-004 double tap = one order; closed hours stop ordering but not browsing; a disabled QR fails safely", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token, tableId } = await tableToken(outlet.id, "F1");
    const guest = await phone(browser);
    const g = guest.page;
    await g.goto(`/t/${token}`);
    await g.getByRole("button", { name: "Add Masala Chai" }).click();
    await g.getByRole("link", { name: /^View cart/ }).click();
    await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
    const button = g.getByRole("button", { name: "Place order" });
    await expect(button).toBeEnabled();
    const posts: string[] = [];
    g.on("request", (r) => r.method() === "POST" && /\/api\/qr\/t\/.+\/orders$/.test(r.url()) && posts.push(r.url()));
    await button.dblclick();
    await g.waitForURL(/\/o\//);
    expect(posts).toHaveLength(1);
    const onTable = (await apiData<{ items: Array<{ id: string; source: string }> }>(page.request, `/api/orders?outletId=${outlet.id}&tableId=${tableId}&take=50`)).items;
    expect(onTable.filter((o) => o.source === "QR")).toHaveLength(1); // (the demo seed's own POS order at F1 aside)

    // Closed: hours that do not include "now" (outlet timezone).
    const db = await e2eDb();
    const hh = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    const now = Date.now();
    await db.outlet.update({ where: { id: outlet.id }, data: { openTime: hh(new Date(now + 2 * 3600_000)), closeTime: hh(new Date(now + 3 * 3600_000)) } });
    try {
      await g.goto(`/t/${token}`);
      await expect(g.getByRole("status").filter({ hasText: "We're closed right now" })).toBeVisible();
      await expect(g.getByRole("button", { name: "Add Masala Chai" })).toBeDisabled();
      await expect(g.getByRole("heading", { name: "Starters" })).toBeVisible(); // the menu is still browsable
      const refused = await g.request.post(`/api/qr/t/${token}/orders`, { data: { items: [{ menuItemId: (await apiData<{ menu: MenuRow[] }>(g.request, `/api/qr/t/${token}`)).menu.find((m) => m.name === "Masala Chai")!.id, qty: 1 }] }, headers: { "idempotency-key": "e2e-closed-0001", origin: new URL(g.url()).origin } });
      expect(refused.status()).toBe(422);
    } finally {
      await db.outlet.update({ where: { id: outlet.id }, data: { openTime: null, closeTime: null } });
    }

    // The owner disables QR ordering at this table: the printed code stops working, with no detail.
    const manager = await apiAs("manager");
    expect((await apiCall(manager, "POST", `/api/master/tables/${tableId}/qr/revoke`)).status).toBe(200);
    await g.goto(`/t/${token}`);
    await expect(g.getByRole("heading", { name: "This QR code isn't working" })).toBeVisible();
    await db.$disconnect();
    await guest.context.close();
  });
});
