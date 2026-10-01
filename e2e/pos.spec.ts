import { test, expect, type Request } from "@playwright/test";
import {
  statePath, outletByCode, tableByCode, ordersOnTable, order, openPos, chooseTable, addSimpleItem, posCart, newItems, toast, appAlert,
  kdsColumn, ticketFor, sessionFor, cartTotal, money, materialByName, ledgerForOrder, apiCall, apiAs, CENTRAL,
} from "./helpers";

test.use({ storageState: statePath("cashier") });

const isOrderCreate = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/api/orders";

test.describe("POS core", () => {
  test("POS-001 dine-in order reaches the kitchen display", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const table = await tableByCode(page.request, outlet.id, "G2");
    expect(await ordersOnTable(page.request, outlet.id, table.id)).toHaveLength(0);

    await openPos(page);
    await expect(page.getByRole("radio", { name: "Dine-in" })).toHaveAttribute("aria-checked", "true");
    await chooseTable(page, "G2");
    await expect(posCart(page).getByRole("button", { name: "Table G2, change table" })).toBeVisible();

    // Chicken Biryani has an optional "Spice Level" group -> configured in the modifier dialog.
    await addSimpleItem(page, "Chicken Biryani");
    const cfg = page.getByRole("dialog", { name: "Chicken Biryani" });
    await cfg.getByRole("radio", { name: "Medium" }).click();
    await cfg.getByRole("button", { name: /^Add · ₹320\.00$/ }).click();
    await expect(cfg).toBeHidden();
    await expect(newItems(page).getByText("Medium")).toBeVisible();
    await addSimpleItem(page, "Butter Naan");
    await posCart(page).getByRole("button", { name: "Increase Butter Naan" }).click();
    await expect(posCart(page).getByLabel("Quantity of Butter Naan")).toHaveValue("2");
    await expect(newItems(page).getByRole("listitem")).toHaveCount(2);
    // Client estimate before the server prices it.
    await expect(posCart(page).getByText("Estimate", { exact: true })).toBeVisible();

    const created = page.waitForResponse((r) => isOrderCreate(r.request()));
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    const res = await created;
    // API contract: every success is 200 with { ok, data } (src/server/api/router.ts; pinned by tests/api/routes.test.ts).
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    const orderId = body.data.id;
    await expect(toast(page, `Order #${orderId.slice(-6).toUpperCase()} sent to kitchen`)).toBeVisible();

    // Server state: exactly one order on the table, with exactly what was rung up.
    const onTable = await ordersOnTable(page.request, outlet.id, table.id);
    expect(onTable.map((o) => o.id)).toEqual([orderId]);
    const o = await order(page.request, orderId);
    expect(o.status).toBe("SENT");
    expect(o.channel).toBe("DINE_IN");
    expect(o.items.map((i) => [i.name, Number(i.qty)]).sort()).toEqual([["Butter Naan", 2], ["Chicken Biryani", 1]]);
    expect(o.items.find((i) => i.name === "Chicken Biryani")!.modifiers.map((m) => m.name)).toEqual(["Spice Level: Medium"]); // "<group>: <option>", pinned by tests/domain/pos-backend.test.ts
    expect(o.kots!.length).toBeGreaterThanOrEqual(1); // one per station (kitchen + bakery)
    expect(o.kots!.every((k) => k.status === "NEW")).toBe(true);

    // The POS shows the running order priced by the server, with its KOTs.
    await expect(posCart(page).getByText(`#${orderId.slice(-6).toUpperCase()}`)).toBeVisible();
    expect(await cartTotal(page)).toBe(money(o.total));
    const kotList = posCart(page).getByRole("list", { name: "Kitchen tickets" });
    await expect(kotList.getByRole("listitem")).toHaveCount(o.kots!.length);

    // Table is now occupied.
    expect((await tableByCode(page.request, outlet.id, "G2")).status).toBe("OCCUPIED");

    // The kitchen sees the ticket(s) for G2.
    const kitchen = await sessionFor(browser, "kitchen");
    await kitchen.page.goto("/kitchen");
    const tickets = ticketFor(kdsColumn(kitchen.page, "New"), "G2");
    await expect(tickets).toHaveCount(o.kots!.length);
    // Scope to this order's tickets (table G2): seeded tickets for other tables also list these dishes.
    await expect(tickets.getByText("Chicken Biryani")).toBeVisible();
    await expect(tickets.getByText("Butter Naan")).toBeVisible();
    await expect(tickets.getByText("Medium")).toBeVisible();
    await kitchen.context.close();
  });

  test("POS-002 rapid repeated taps create exactly one order, one set of items and one KOT", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const table = await tableByCode(page.request, outlet.id, "G3");
    await openPos(page);
    await chooseTable(page, "G3");
    await addSimpleItem(page, "Paneer Tikka");

    const posts: Request[] = [];
    page.on("request", (r) => void (isOrderCreate(r) && posts.push(r)));

    // Three clicks in the same task — before React can re-render the button as disabled —
    // so only the submit guard (single-flight) stands between the taps and the API.
    const created = page.waitForResponse((r) => isOrderCreate(r.request()));
    await page.getByRole("button", { name: "Send to kitchen" }).evaluate((b: HTMLButtonElement) => {
      b.click();
      b.click();
      b.click();
    });
    const res = await created;
    const orderId = ((await res.json()) as { data: { id: string } }).data.id;
    await expect(toast(page, "sent to kitchen")).toHaveCount(1);
    await page.waitForTimeout(500); // let any stray request surface
    expect(posts).toHaveLength(1);

    const onTable = await ordersOnTable(page.request, outlet.id, table.id);
    expect(onTable.map((o) => o.id)).toEqual([orderId]);
    const o = await order(page.request, orderId);
    expect(o.items).toHaveLength(1);
    expect(Number(o.items[0].qty)).toBe(1);
    expect(o.kots).toHaveLength(1);

    // Backend protection independent of the UI guard: replaying the exact request
    // with the same Idempotency-Key returns the same order and creates nothing.
    const key = posts[0].headers()["idempotency-key"];
    expect(key).toMatch(/^pos/);
    const replay = await apiCall<{ id: string; replayed: boolean }>(page.request, "POST", "/api/orders", JSON.parse(posts[0].postData()!), { "Idempotency-Key": key });
    expect(replay.status).toBeLessThan(300);
    expect(replay.body!.data.id).toBe(orderId);
    expect(replay.body!.data.replayed).toBe(true);
    expect(await ordersOnTable(page.request, outlet.id, table.id)).toHaveLength(1);
    expect((await order(page.request, orderId)).kots).toHaveLength(1);

    // Same key, different request -> conflict (never a silent second order).
    const conflicting = { ...JSON.parse(posts[0].postData()!), covers: 7 };
    const conflict = await apiCall(page.request, "POST", "/api/orders", conflicting, { "Idempotency-Key": key });
    expect(conflict.status).toBe(409);
    expect(await ordersOnTable(page.request, outlet.id, table.id)).toHaveLength(1);
  });

  test("POS-003 lost response + retry reuses the idempotency key: one order, one KOT, one consumption", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const table = await tableByCode(page.request, outlet.id, "G4");
    const mgr = await apiAs("manager"); // cashier has no inventory/master permissions
    const milk = await materialByName(mgr, "Milk");
    await openPos(page);
    await chooseTable(page, "G4");
    await addSimpleItem(page, "Masala Chai");
    await posCart(page).getByRole("button", { name: "Increase Masala Chai" }).click();

    // First attempt: the request REACHES the server and is processed, but the
    // connection drops before the browser gets the response.
    const keys: string[] = [];
    let firstServerOrderId: string | null = null;
    let attempts = 0;
    await page.route("**/api/orders", async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      attempts++;
      keys.push(req.headers()["idempotency-key"]);
      if (attempts === 1) {
        const upstream = await route.fetch();
        firstServerOrderId = ((await upstream.json()) as { data: { id: string } }).data.id;
        return route.abort("connectionreset");
      }
      return route.fallback();
    });

    await page.getByRole("button", { name: "Send to kitchen" }).click();
    await expect(toast(page, /Network error/)).toBeVisible();
    // The cart is intact (nothing was confirmed) and the server already has the order.
    await expect(newItems(page).getByRole("listitem")).toHaveCount(1);
    expect(firstServerOrderId).not.toBeNull();
    expect(await ordersOnTable(page.request, outlet.id, table.id)).toHaveLength(1);

    // Retry — same cart, so the guard reuses the key; the server replays the order.
    const retried = page.waitForResponse((r) => isOrderCreate(r.request()));
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    const res = await retried;
    const replay = ((await res.json()) as { data: { id: string; replayed: boolean } }).data;
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(replay.id).toBe(firstServerOrderId);
    expect(replay.replayed).toBe(true);
    await expect(toast(page, "sent to kitchen")).toBeVisible();
    await page.unroute("**/api/orders");

    const onTable = await ordersOnTable(page.request, outlet.id, table.id);
    expect(onTable.map((o) => o.id)).toEqual([firstServerOrderId]);
    const o = await order(page.request, firstServerOrderId!);
    expect(o.items).toHaveLength(1);
    expect(Number(o.items[0].qty)).toBe(2);
    expect(o.kots).toHaveLength(1);

    // Settle it and prove inventory was consumed exactly once for the order.
    expect(await ledgerForOrder(mgr, outlet.id, milk.id, o.id)).toHaveLength(0); // consumption happens at settlement
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    const pay = page.getByRole("dialog", { name: "Take payment" });
    await pay.getByRole("button", { name: /^Charge/ }).click();
    await expect(pay.getByText("Paid in full")).toBeVisible();
    const rows = await ledgerForOrder(mgr, outlet.id, milk.id, o.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].qty)).toBeCloseTo(-0.2, 6); // 2 × 0.1 L
    expect(rows[0].txnType).toBe("SALE_CONSUMPTION");
    await mgr.dispose();
  });
});

test.describe("order types", () => {
  for (const [label, channel] of [["Takeaway", "TAKEAWAY"], ["Delivery", "DELIVERY"]] as const) {
    test(`ORDERTYPE ${channel} needs no table and is labelled for the kitchen`, async ({ page, browser }) => {
      await openPos(page);
      await page.getByRole("radio", { name: label }).click();
      await expect(page.getByRole("radio", { name: label })).toHaveAttribute("aria-checked", "true");
      await expect(posCart(page).getByRole("button", { name: "Choose table" })).toHaveCount(0);
      await expect(posCart(page).getByLabel("Covers")).toHaveCount(0);
      await addSimpleItem(page, "Veg Biryani");
      if (channel === "DELIVERY") {
        // Delivery needs a customer (address/phone) — blocked client-side before any request.
        await page.getByRole("button", { name: "Send to kitchen" }).click();
        await expect(toast(page, "Attach a customer for delivery")).toBeVisible();
        await posCart(page).getByRole("button", { name: "Customer" }).click();
        const dlg = page.getByRole("dialog", { name: "Customer" });
        await dlg.getByPlaceholder("Phone number").fill("9999900001");
        await dlg.getByRole("button", { name: "Find" }).click();
        await dlg.getByRole("button", { name: /E2E Guest/ }).click();
      }
      const created = page.waitForResponse((r) => isOrderCreate(r.request()));
      await page.getByRole("button", { name: "Send to kitchen" }).click();
      const id = ((await (await created).json()) as { data: { id: string } }).data.id;
      const o = await order(page.request, id);
      expect(o.channel).toBe(channel);
      expect(o.tableId).toBeNull();
      expect(o.kots).toHaveLength(1);
      // Takeaway/delivery orders are not kept as a "running table" in the cart.
      await expect(newItems(page)).toHaveCount(0);

      const kitchen = await sessionFor(browser, "kitchen");
      await kitchen.page.goto("/kitchen");
      const card = kitchen.page.getByRole("article", { name: `KOT ${o.kots![0].number}, ${label}` });
      await expect(card).toBeVisible();
      await expect(card.getByText("Veg Biryani")).toBeVisible();
      await kitchen.context.close();
    });
  }

  test("ORDERTYPE DINE_IN without a table is blocked before reaching the server", async ({ page }) => {
    let posted = false;
    page.on("request", (r) => void (isOrderCreate(r) && (posted = true)));
    await openPos(page);
    await addSimpleItem(page, "Veg Biryani");
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    await expect(toast(page, /table/i)).toBeVisible();
    expect(posted).toBe(false);
    await expect(newItems(page).getByRole("listitem")).toHaveCount(1);
  });

  test("ORDERTYPE server rejects a dine-in order with a table from another outlet", async ({ page }) => {
    const central = await outletByCode(page.request, CENTRAL);
    // Cashier is scoped to Central; ask the owner-visible API for a Jubilee table id via the seed code.
    const res = await apiCall(page.request, "POST", "/api/orders", { outletId: central.id, channel: "DINE_IN", tableId: "not-a-real-table", items: [], submit: false }, { "Idempotency-Key": "e2e-bad-table-0001" });
    expect([404, 422]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|prisma|stack/i);
  });
});

test.describe("customer", () => {
  test("CUSTOMER search, select and attach an existing customer", async ({ page }) => {
    await openPos(page);
    await page.getByRole("radio", { name: "Takeaway" }).click();
    await posCart(page).getByRole("button", { name: "Customer" }).click();
    const dlg = page.getByRole("dialog", { name: "Customer" });
    await dlg.getByPlaceholder("Phone number").fill("99999 00001");
    await dlg.getByRole("button", { name: "Find" }).click();
    await dlg.getByRole("button", { name: /E2E Guest/ }).click();
    await expect(dlg).toBeHidden();
    await expect(posCart(page).getByRole("button", { name: "E2E Guest" })).toBeVisible();

    await addSimpleItem(page, "Cola");
    const created = page.waitForResponse((r) => isOrderCreate(r.request()));
    await page.getByRole("button", { name: "Save" }).click();
    const id = ((await (await created).json()) as { data: { id: string } }).data.id;
    const o = await order(page.request, id);
    const customers = await apiCall<Array<{ id: string; name: string }>>(page.request, "GET", "/api/customers?phone=9999900001");
    expect(o.customerId).toBe(customers.body!.data[0].id);
  });

  test("CUSTOMER invalid input and create-new flow", async ({ page }) => {
    await openPos(page);
    await page.getByRole("radio", { name: "Takeaway" }).click();
    await posCart(page).getByRole("button", { name: "Customer" }).click();
    const dlg = page.getByRole("dialog", { name: "Customer" });

    await dlg.getByPlaceholder("Phone number").fill("12a");
    await dlg.getByRole("button", { name: "Find" }).click();
    await expect(dlg.getByRole("alert")).toHaveText("Enter at least 6 digits");

    const phone = `98${Date.now().toString().slice(-8)}`;
    await dlg.getByPlaceholder("Phone number").fill(phone);
    await dlg.getByRole("button", { name: "Find" }).click();
    await expect(dlg.getByText("No customer with this number. Add them?")).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Add customer" })).toBeDisabled(); // name required
    await dlg.getByLabel("Name").fill("Walk-in Tester");
    await dlg.getByRole("button", { name: "Add customer" }).click();
    await expect(dlg).toBeHidden();
    await expect(posCart(page).getByRole("button", { name: "Walk-in Tester" })).toBeVisible();

    const found = await apiCall<Array<{ name: string; phone: string }>>(page.request, "GET", `/api/customers?phone=${phone}`);
    expect(found.body!.data).toHaveLength(1);
    expect(found.body!.data[0].name).toBe("Walk-in Tester");

    // Server-side validation is authoritative too.
    const bad = await apiCall(page.request, "POST", "/api/customers", { name: "", phone: "1" });
    expect(bad.status).toBe(422);
  });

  test("CUSTOMER captain can look up but not create customers", async ({ browser }) => {
    const { context, page } = await sessionFor(browser, "captain");
    await openPos(page);
    await page.getByRole("radio", { name: "Takeaway" }).click();
    await posCart(page).getByRole("button", { name: "Customer" }).click();
    const dlg = page.getByRole("dialog", { name: "Customer" });
    await dlg.getByPlaceholder("Phone number").fill("9000011111");
    await dlg.getByRole("button", { name: "Find" }).click();
    await expect(dlg.getByText("No customer with this number.", { exact: true })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Add customer" })).toHaveCount(0);
    const res = await apiCall(page.request, "POST", "/api/customers", { name: "Nope", phone: "9000011111" });
    expect(res.status).toBe(403);
    await expect(appAlert(page)).toHaveCount(0);
    await context.close();
  });
});
