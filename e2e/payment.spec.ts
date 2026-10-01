import { test, expect, type Page, type Request } from "@playwright/test";
import { statePath, outletByCode, order, openPos, addSimpleItem, apiCall, apiAs, materialByName, ledgerForOrder, toast, CENTRAL } from "./helpers";

test.use({ storageState: statePath("cashier") });

const isOrderCreate = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/api/orders";
const isPaymentCreate = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/api/payments";

/** Ring up a takeaway order through the UI and open the payment dialog ("Send & pay"). */
async function takeawayToPayment(page: Page, items: string[]) {
  await openPos(page);
  await page.getByRole("radio", { name: "Takeaway" }).click();
  for (const i of items) await addSimpleItem(page, i);
  const created = page.waitForResponse((r) => isOrderCreate(r.request()));
  await page.getByRole("button", { name: "Send & pay" }).click();
  const orderId = ((await (await created).json()) as { data: { id: string } }).data.id;
  const dlg = page.getByRole("dialog", { name: "Take payment" });
  await expect(dlg.getByText("Amount due")).toBeVisible();
  return { orderId, dlg };
}

test.describe("payment", () => {
  test("PAYMENT-001 cash with change", async ({ page }) => {
    const { orderId, dlg } = await takeawayToPayment(page, ["Cold Coffee"]); // 160 + 5% = 168
    const o = await order(page.request, orderId);
    expect(Number(o.total)).toBe(168);
    await expect(dlg.getByText("₹168.00").first()).toBeVisible();
    await expect(dlg.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");

    await dlg.getByRole("button", { name: "₹500.00" }).click();
    await expect(dlg.getByLabel("Cash received")).toHaveValue("500");
    await expect(dlg.getByText("Change to return: ₹332.00")).toBeVisible();
    await dlg.getByRole("button", { name: "Charge ₹168.00" }).click();
    await expect(dlg.getByText("Paid in full")).toBeVisible();
    await expect(dlg.getByText("Change ₹332.00")).toBeVisible();

    const paid = await order(page.request, orderId);
    expect(paid.status).toBe("PAID");
    expect(paid.payments!.map((p) => [p.status, Number(p.amount)])).toEqual([["SUCCESS", 168]]); // the amount due, not the cash handed over
    await dlg.getByRole("button", { name: "Done" }).click();
    await expect(dlg).toBeHidden();
    await expect(toast(page, "Payment complete")).toBeVisible();
  });

  test("PAYMENT-002 exact amount, and non-cash cannot exceed the balance", async ({ page }) => {
    const { orderId, dlg } = await takeawayToPayment(page, ["Masala Chai"]); // 42
    await dlg.getByRole("radio", { name: "Card" }).click();
    await dlg.getByLabel("Amount to charge").fill("50");
    await expect(dlg.getByText("Amount exceeds the balance due")).toBeVisible();
    await expect(dlg.getByRole("button", { name: /^Charge/ })).toBeDisabled();

    await dlg.getByRole("radio", { name: "Cash" }).click();
    await dlg.getByLabel("Cash received").fill("42");
    await expect(dlg.getByText(/Change to return/)).toHaveCount(0);
    await dlg.getByRole("button", { name: "Charge ₹42.00" }).click();
    await expect(dlg.getByText("Paid in full")).toBeVisible();
    await expect(dlg.getByText(/^Change /)).toHaveCount(0);
    const paid = await order(page.request, orderId);
    expect(paid.status).toBe("PAID");
    expect(paid.payments!.map((p) => [p.status, Number(p.amount)])).toEqual([["SUCCESS", 42]]);
  });

  test("PAYMENT-003 insufficient cash is a partial payment; the balance stays due", async ({ page }) => {
    const { orderId, dlg } = await takeawayToPayment(page, ["Cold Coffee"]); // 168
    await dlg.getByLabel("Cash received").fill("0");
    await expect(dlg.getByText("Enter an amount greater than zero")).toBeVisible();
    await expect(dlg.getByRole("button", { name: /^Charge/ })).toBeDisabled();

    await dlg.getByLabel("Cash received").fill("100");
    await expect(dlg.getByText("Partial payment — ₹68.00 will remain")).toBeVisible();
    await dlg.getByRole("button", { name: "Charge ₹100.00" }).click();
    // Dialog stays open for the remaining balance; the order is NOT paid.
    // Wait for the post-charge refresh: the tendered amount resets to the remaining balance.
    // (A bare "₹68.00" text match also hits the pre-charge "Partial payment — ₹68.00 will remain" hint.)
    await expect(dlg.getByLabel("Cash received")).toHaveValue("68");
    await expect(dlg.getByText("Partial payment")).toHaveCount(0);
    await expect(dlg.getByText("₹68.00").first()).toBeVisible();
    await expect(dlg.getByText("Paid in full")).toHaveCount(0);
    const partial = await order(page.request, orderId);
    expect(partial.status).not.toBe("PAID");
    expect(partial.payments!.map((p) => [p.status, Number(p.amount)])).toEqual([["SUCCESS", 100]]);

    await dlg.getByRole("button", { name: "Charge ₹68.00" }).click();
    await expect(dlg.getByText("Paid in full")).toBeVisible();
    const paid = await order(page.request, orderId);
    expect(paid.status).toBe("PAID");
    expect(paid.payments!.map((p) => Number(p.amount)).sort((a, b) => a - b)).toEqual([68, 100]);
  });

  test("PAYMENT-004a lost response on payment creation: retry does not create a second payment", async ({ page }) => {
    const { orderId, dlg } = await takeawayToPayment(page, ["Cold Coffee"]);
    const keys: Array<string | undefined> = [];
    let attempt = 0;
    await page.route("**/api/payments", async (route) => {
      if (!isPaymentCreate(route.request())) return route.fallback();
      attempt++;
      keys.push(route.request().headers()["idempotency-key"]);
      if (attempt === 1) {
        await route.fetch(); // reaches the server: a PENDING payment now exists
        return route.abort("connectionreset");
      }
      return route.fallback();
    });

    await dlg.getByRole("button", { name: "Charge ₹168.00" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Network error");
    const afterFailure = await order(page.request, orderId);
    expect(afterFailure.payments).toHaveLength(1); // the server did record it

    await dlg.getByRole("button", { name: /^Charge ₹168\.00$|^Retry confirmation$/ }).click();
    await expect(dlg.getByText("Paid in full")).toBeVisible();
    await page.unroute("**/api/payments");

    expect(keys.length).toBeGreaterThanOrEqual(1);
    if (keys.length === 2) expect(keys[1]).toBe(keys[0]);
    const paid = await order(page.request, orderId);
    expect(paid.status).toBe("PAID");
    expect(paid.payments!.map((p) => [p.status, Number(p.amount)])).toEqual([["SUCCESS", 168]]); // one payment, no orphan
  });

  test("PAYMENT-004b lost response on verification: retry re-verifies the same payment; stock consumed once", async ({ page }) => {
    const mgr = await apiAs("manager");
    const outlet = await outletByCode(page.request, CENTRAL);
    const milk = await materialByName(mgr, "Milk");
    const { orderId, dlg } = await takeawayToPayment(page, ["Masala Chai"]);

    let attempt = 0;
    await page.route("**/api/payments/*/verify", async (route) => {
      attempt++;
      if (attempt === 1) {
        await route.fetch(); // server verifies: payment SUCCESS, order PAID, stock consumed
        return route.abort("connectionreset");
      }
      return route.fallback();
    });
    await dlg.getByRole("button", { name: "Charge ₹42.00" }).click();
    await expect(dlg.getByRole("alert")).toContainText("do not charge the guest again");
    // The method and amount are locked while a retry is pending.
    await expect(dlg.getByRole("radio", { name: "Card" })).toBeDisabled();
    await dlg.getByRole("button", { name: "Retry confirmation" }).click();
    await expect(dlg.getByText("Paid in full")).toBeVisible();
    await page.unroute("**/api/payments/*/verify");

    const paid = await order(page.request, orderId);
    expect(paid.status).toBe("PAID");
    expect(paid.payments).toHaveLength(1);
    const rows = await ledgerForOrder(mgr, outlet.id, milk.id, orderId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].qty)).toBeCloseTo(-0.1, 6);
    await mgr.dispose();
  });

  test("PAYMENT-005 paying an order that was already settled elsewhere shows a clear error", async ({ page }) => {
    const { orderId, dlg } = await takeawayToPayment(page, ["Cola"]); // 63
    // Another till settles it while this dialog is open (real API, same outlet staff).
    const p = await apiCall<{ id: string }>(page.request, "POST", "/api/payments", { orderId, method: "UPI", amount: 63 });
    // API contract: every success is 200 with { ok, data } (src/server/api/router.ts; pinned by tests/api/routes.test.ts).
    expect(p.status).toBe(200);
    expect((await apiCall(page.request, "POST", `/api/payments/${p.body!.data.id}/verify`, {})).status).toBe(200);

    await dlg.getByRole("button", { name: "Charge ₹63.00" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Cannot take payment for a PAID order");
    await expect(dlg.getByRole("alert")).not.toContainText(/stack|prisma|Error:/i);
    const o = await order(page.request, orderId);
    expect(o.payments!.map((x) => [x.method, x.status])).toEqual([["UPI", "SUCCESS"]]); // no second payment
  });
});
