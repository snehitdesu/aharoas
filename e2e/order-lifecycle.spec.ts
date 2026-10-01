/**
 * One dine-in order through its whole life, across three real browser sessions:
 * cashier rings it up, adds a second round and a discount; the kitchen takes the
 * tickets through Accept → Start → Ready → Served; the cashier settles it; the
 * inventory ledger shows the recipe consumption. Plus cancellation (manager
 * only). Every step is verified against the server, not just the screen.
 */
import { test, expect, type Request } from "@playwright/test";
import {
  statePath, outletByCode, tableByCode, ordersOnTable, order, openPos, chooseTable, addSimpleItem, posCart, newItems, toast,
  kdsColumn, ticketFor, sessionFor, materialByName, stockQty, ledgerForOrder, apiAs, CENTRAL, money,
} from "./helpers";

test.use({ storageState: statePath("cashier") });

const isOrderCreate = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/api/orders";
const sum = (rows: Array<{ qty: string | number }>) => rows.reduce((a, r) => a + Number(r.qty), 0);

test.describe("order lifecycle", () => {
  test("FLOW-001 create → second round → discount → KOTs → KDS lifecycle → payment → stock consumption", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const table = await tableByCode(page.request, outlet.id, "G5");
    expect(await ordersOnTable(page.request, outlet.id, table.id)).toHaveLength(0);
    const manager = await apiAs("manager");
    const paneer = await materialByName(manager, "Paneer");
    const milk = await materialByName(manager, "Milk");
    const paneerBefore = await stockQty(manager, outlet.id, paneer.id);
    const milkBefore = await stockQty(manager, outlet.id, milk.id);

    // 1. Create: Paneer Tikka (kitchen station) to table G5, sent to the kitchen.
    await openPos(page);
    await chooseTable(page, "G5");
    await addSimpleItem(page, "Paneer Tikka");
    const created = page.waitForResponse((r) => isOrderCreate(r.request()));
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    const orderId = ((await (await created).json()) as { data: { id: string } }).data.id;
    await expect(toast(page, `Order #${orderId.slice(-6).toUpperCase()} sent to kitchen`)).toBeVisible();
    let o = await order(page.request, orderId);
    expect(o.status).toBe("SENT");
    expect(o.kots).toHaveLength(1);

    // 2. Modify: the running order stays open on G5; a second round (2 × Masala Chai, bar station).
    await expect(posCart(page).getByText("Already ordered")).toBeVisible();
    await addSimpleItem(page, "Masala Chai");
    await posCart(page).getByRole("button", { name: "Increase Masala Chai" }).click();
    await expect(newItems(page).getByRole("listitem")).toHaveCount(1);
    const fired = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/orders/${orderId}/fire`);
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    expect((await fired).status()).toBe(200);
    await expect(toast(page, /^Sent to kitchen$/)).toBeVisible();
    o = await order(page.request, orderId);
    expect(o.items.map((i) => [i.name, Number(i.qty)]).sort()).toEqual([["Masala Chai", 2], ["Paneer Tikka", 1]]);
    expect(o.kots).toHaveLength(2); // one per round (kitchen, then bar)
    expect(await ordersOnTable(page.request, outlet.id, table.id)).toHaveLength(1); // same order, not a new one
    const totalBeforeDiscount = Number(o.total);

    // 3. Modify: discount (cashier holds order.discount); cancellation is not offered to a cashier.
    await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    await page.getByRole("button", { name: "Discount" }).click();
    const disc = page.getByRole("dialog", { name: "Order discount" });
    await disc.getByLabel("Discount amount (₹)").fill("20");
    await disc.getByRole("button", { name: "Apply" }).click();
    await expect(toast(page, "Discount applied")).toBeVisible();
    o = await order(page.request, orderId);
    expect(Number((o as unknown as { discount: string }).discount)).toBe(20);
    expect(Number(o.total)).toBeLessThan(totalBeforeDiscount);

    // 4. KDS: the kitchen takes the Paneer Tikka ticket through its lifecycle.
    const kitchen = await sessionFor(browser, "kitchen");
    await kitchen.page.goto("/kitchen");
    const ticket = (col: "New" | "In progress" | "Ready") => ticketFor(kdsColumn(kitchen.page, col), "G5").filter({ hasText: "Paneer Tikka" });
    await expect(ticket("New")).toHaveCount(1);
    await ticket("New").getByRole("button", { name: "Accept" }).click();
    await expect(ticket("In progress")).toHaveCount(1);
    await ticket("In progress").getByRole("button", { name: "Start" }).click();
    await expect(ticket("In progress").getByRole("button", { name: "Ready" })).toBeVisible();
    await ticket("In progress").getByRole("button", { name: "Ready" }).click();
    await expect(ticket("Ready")).toHaveCount(1);
    const kitchenKot = (await order(page.request, orderId)).kots!.find((k) => k.status !== "NEW")!;
    expect(kitchenKot.status).toBe("READY");
    await ticket("Ready").getByRole("button", { name: "Served" }).click();
    await expect(ticket("Ready")).toHaveCount(0);
    expect((await order(page.request, orderId)).kots!.map((k) => k.status).sort()).toEqual(["NEW", "SERVED"]); // bar ticket untouched
    await kitchen.context.close();

    // 5. Payment: settle the running order in cash.
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    const pay = page.getByRole("dialog", { name: "Take payment" });
    const due = (await order(page.request, orderId)).total;
    await pay.getByLabel("Cash received").fill(String(Number(due)));
    await pay.getByRole("button", { name: `Charge ${money(due)}` }).click();
    await expect(pay.getByText("Paid in full")).toBeVisible();
    await pay.getByRole("button", { name: "Done" }).click();
    o = await order(page.request, orderId);
    expect(o.status).toBe("PAID");
    expect(o.payments!.filter((p) => p.status === "SUCCESS").map((p) => Number(p.amount))).toEqual([Number(due)]);

    // 6. Inventory: recipe consumption hit the ledger exactly once (Paneer Tikka 0.2 kg paneer; Masala Chai 0.1 L milk each).
    await expect.poll(async () => sum(await ledgerForOrder(manager, outlet.id, paneer.id, orderId))).toBeCloseTo(-0.2, 5);
    expect(sum(await ledgerForOrder(manager, outlet.id, milk.id, orderId))).toBeCloseTo(-0.2, 5);
    expect(await stockQty(manager, outlet.id, paneer.id)).toBeCloseTo(paneerBefore - 0.2, 5);
    expect(await stockQty(manager, outlet.id, milk.id)).toBeCloseTo(milkBefore - 0.2, 5);
    await manager.dispose();
  });

  test("FLOW-002 a manager cancels a saved order with a reason; nothing is consumed", async ({ browser }) => {
    const { context, page } = await sessionFor(browser, "manager");
    const outlet = await outletByCode(page.request, CENTRAL);
    await openPos(page);
    await chooseTable(page, "G6");
    await addSimpleItem(page, "Butter Naan");
    const created = page.waitForResponse((r) => isOrderCreate(r.request()));
    await page.getByRole("button", { name: "Save" }).click();
    const orderId = ((await (await created).json()) as { data: { id: string } }).data.id;
    await expect(toast(page, `Order #${orderId.slice(-6).toUpperCase()} saved`)).toBeVisible();
    expect((await order(page.request, orderId)).status).toBe("OPEN");

    await page.getByRole("button", { name: "Cancel order" }).click();
    const dlg = page.getByRole("dialog", { name: "Cancel order" });
    await expect(dlg.getByRole("button", { name: "Cancel order" })).toBeDisabled(); // reason required
    await dlg.getByLabel("Reason (required)").fill("Guest left before ordering");
    await dlg.getByRole("button", { name: "Cancel order" }).click();
    await expect(toast(page, "Order cancelled")).toBeVisible();
    expect((await order(page.request, orderId)).status).toBe("CANCELLED");
    const flour = await materialByName(page.request, "Wheat Flour");
    expect(await ledgerForOrder(page.request, outlet.id, flour.id, orderId)).toHaveLength(0);
    await context.close();
  });
});
