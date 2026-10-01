/**
 * Guest-facing workflows:
 *  - CRM: a POS sale attached to a customer earns loyalty only once it is paid,
 *    and the manager sees the order and the points on the customer profile
 *  - reservations: book (existing guest) → confirm → seat at a table → complete
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, tableByCode, apiData, apiAs, openPos, addSimpleItem, posCart, order, sessionFor, money, CENTRAL } from "./helpers";

test.use({ storageState: statePath("cashier") });

type Loyalty = { balance: number; history: { items: Array<{ type: string; points: number; orderId: string | null }> } };
const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

test.describe("guests", () => {
  test("CRM-001 a paid order attached to a customer earns loyalty visible on the profile", async ({ page, browser }) => {
    const manager = await apiAs("manager");
    const [guest] = await apiData<Array<{ id: string; name: string }>>(manager, "/api/customers?phone=9999900001");
    const before = await apiData<Loyalty>(manager, `/api/loyalty/customers/${guest.id}`);

    await openPos(page);
    await page.getByRole("radio", { name: "Takeaway" }).click();
    await posCart(page).getByRole("button", { name: "Customer" }).click();
    const pick = page.getByRole("dialog", { name: "Customer" });
    await pick.getByPlaceholder("Phone number").fill("9999900001");
    await pick.getByRole("button", { name: "Find" }).click();
    await pick.getByRole("button", { name: /E2E Guest/ }).click();
    await addSimpleItem(page, "Cold Coffee");
    await addSimpleItem(page, "Cold Coffee");
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/orders");
    await page.getByRole("button", { name: "Send & pay" }).click();
    const orderId = ((await (await created).json()) as { data: { id: string } }).data.id;

    // Sent but not paid: no points yet.
    expect((await apiData<Loyalty>(manager, `/api/loyalty/customers/${guest.id}`)).balance).toBe(before.balance);

    const pay = page.getByRole("dialog", { name: "Take payment" });
    const due = (await order(page.request, orderId)).total;
    await pay.getByLabel("Cash received").fill(String(Number(due)));
    await pay.getByRole("button", { name: `Charge ${money(due)}` }).click();
    await expect(pay.getByText("Paid in full")).toBeVisible();
    await pay.getByRole("button", { name: "Done" }).click();

    const after = await apiData<Loyalty>(manager, `/api/loyalty/customers/${guest.id}`);
    const earn = after.history.items.find((h) => h.orderId === orderId && h.type === "EARN");
    expect(earn, "EARN entry for this order").toBeTruthy();
    expect(earn!.points).toBeGreaterThan(0);
    expect(after.balance).toBe(before.balance + earn!.points);

    // The manager sees it on the profile.
    const m = await sessionFor(browser, "manager");
    await m.page.goto(`/customers/${guest.id}`);
    await expect(m.page.getByRole("table", { name: "Order history" }).getByText(money(due)).first()).toBeVisible();
    await m.page.getByRole("tab", { name: "Loyalty" }).click();
    await expect(m.page.getByRole("table", { name: "Loyalty history" }).getByText(`+${earn!.points}`).first()).toBeVisible();
    await m.context.close();
    await manager.dispose();
  });

  test("RES-001 book → confirm → seat at a table → complete", async ({ browser }) => {
    const { context, page } = await sessionFor(browser, "manager");
    const outlet = await outletByCode(page.request, CENTRAL);
    const table = await tableByCode(page.request, outlet.id, "G7");
    const when = new Date();
    when.setDate(when.getDate() + 1);
    when.setHours(13, 0, 0, 0);
    const day = localInput(when).slice(0, 10);

    await page.goto("/reservations");
    await page.getByRole("button", { name: "New reservation" }).click();
    const dlg = page.getByRole("dialog", { name: "New reservation" });
    await dlg.getByLabel(/^Guest phone/).fill("9999900001");
    await dlg.getByLabel(/^Party size/).fill("3");
    await dlg.getByLabel(/^Date & time/).fill(localInput(when));
    await dlg.getByRole("button", { name: "Book" }).click();
    await expect(dlg).toBeHidden();

    await page.getByLabel("From").fill(day);
    await page.getByLabel("To").fill(day);
    const row = page.getByRole("table", { name: "Reservations" }).getByRole("row").filter({ hasText: "E2E Guest" });
    await expect(row).toHaveCount(1);
    const find = async () => (await apiData<{ items: Array<{ id: string; status: string; tableId: string | null; partySize: number; customer: { name: string } }> }>(page.request, `/api/reservations?outletId=${outlet.id}&from=${new Date(when.getTime() - 3600_000).toISOString()}&to=${new Date(when.getTime() + 3600_000).toISOString()}`)).items.find((r) => r.customer?.name === "E2E Guest")!;
    expect((await find())).toMatchObject({ status: "BOOKED", partySize: 3 });

    await row.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(async () => (await find()).status).toBe("CONFIRMED");

    await row.getByRole("button", { name: "Seat" }).click();
    const seat = page.getByRole("dialog", { name: "Seat party" });
    await seat.getByRole("combobox").selectOption(table.id);
    await seat.getByRole("button", { name: "Seat" }).click();
    await expect(seat).toBeHidden();
    await expect.poll(async () => (await find()).status).toBe("SEATED");
    expect((await find()).tableId).toBe(table.id);

    await row.getByRole("button", { name: "Complete" }).click();
    await expect.poll(async () => (await find()).status).toBe("COMPLETED");
    await expect(row.getByRole("button")).toHaveCount(0); // terminal state
    await context.close();
  });
});
