/**
 * Phase 6 phone apps through the real production build (phone viewport, touch):
 *  - MOB-001 captain: tables → G1 → items (options + kitchen note) → one keyed send
 *    → KOT status → kitchen marks it ready → captain marks it served → another
 *    round (atomic, keyed) → request bill → cashier is alerted and collects →
 *    the captain sees the order complete; the table is free again.
 *  - MOB-002 manager: today / live / alerts (Phase 5 insights) → staff: add a
 *    captain behind password re-confirmation (one-time link) → deactivate.
 *  - MOB-003 security: wrong roles and other outlets are refused by the server.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, tableByCode, apiData, apiCall, apiAs, confirmPasswordIfPrompted, CENTRAL } from "./helpers";

test.use({ viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });

const RUN = Date.now().toString(36);

test.describe("captain (phone)", () => {
  test.use({ storageState: statePath("captain") });

  test("MOB-001 table order → kitchen → served → round → bill → paid", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const table = await tableByCode(page.request, outlet.id, "G1");
    await page.goto("/captain");
    const card = page.getByTestId("table-G1");
    await expect(card).toContainText("Free");
    await card.tap();

    await page.getByRole("button", { name: /Add items/ }).tap();
    const sheet = page.getByRole("dialog", { name: "Add items" });
    await sheet.getByRole("searchbox", { name: "Search menu" }).fill("Chicken Biryani");
    await sheet.getByRole("button", { name: /Chicken Biryani/ }).tap();
    const options = page.getByRole("dialog", { name: "Chicken Biryani" });
    await options.getByRole("radio", { name: "Spicy" }).tap();
    await options.getByPlaceholder("e.g. less spicy").fill("extra raita");
    await options.getByRole("button", { name: /^Add · / }).tap();
    await sheet.getByRole("searchbox", { name: "Search menu" }).fill("Paneer Tikka");
    await sheet.getByRole("button", { name: /Paneer Tikka/ }).tap();
    await sheet.getByRole("button", { name: "Done" }).tap();

    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/orders");
    await page.getByRole("button", { name: /^Send/ }).tap();
    const res = await created;
    expect(res.status()).toBe(200);
    expect(res.request().headers()["idempotency-key"]).toMatch(/^cap-/);
    const sent = res.request().postDataJSON() as { items: Array<Record<string, unknown>> };
    expect(sent.items.every((i) => !("unitPrice" in i))).toBe(true);
    const orderId = ((await res.json()) as { data: { id: string } }).data.id;
    const kotsSection = page.getByRole("region", { name: "Kitchen tickets" });
    await expect(kotsSection.getByText(/^KOT \d+$/)).toBeVisible();
    const order = await apiData<{ items: Array<{ name: string; notes: string | null; modifiers: Array<{ name: string }> }>; kots: Array<{ id: string; number: number }> }>(page.request, `/api/orders/${orderId}`);
    expect(order.items.find((i) => i.name === "Chicken Biryani")).toMatchObject({ notes: "extra raita", modifiers: [{ name: "Spice Level: Spicy" }] });

    // The kitchen cooks it; the captain sees "Ready" and hands it over.
    const kitchen = await apiAs("kitchen");
    for (const s of ["ACCEPTED", "PREPARING", "READY"]) expect((await apiCall(kitchen, "POST", `/api/kitchen/kots/${order.kots[0].id}/status`, { status: s })).status).toBe(200);
    await page.reload();
    await page.getByTestId("table-G1").tap();
    await page.getByRole("button", { name: "Mark served" }).tap();
    await expect(kotsSection.getByText("Served")).toBeVisible();

    // A second round: one atomic, keyed request.
    await page.getByRole("button", { name: /Add items/ }).tap();
    await sheet.getByRole("searchbox", { name: "Search menu" }).fill("Masala Chai");
    await sheet.getByRole("button", { name: /Masala Chai/ }).tap();
    await sheet.getByRole("button", { name: "Done" }).tap();
    const round = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/orders/${orderId}/rounds`);
    await page.getByRole("button", { name: /^Send/ }).tap();
    const roundRes = await round;
    expect(roundRes.status()).toBe(200);
    expect(roundRes.request().headers()["idempotency-key"]).toMatch(/^cap-/);
    // Replaying the same request (e.g. a lost response) adds nothing.
    const replay = await apiCall<{ round: { replayed: boolean }; order: { items: unknown[] } }>(page.request, "POST", `/api/orders/${orderId}/rounds`, roundRes.request().postDataJSON(), { "idempotency-key": roundRes.request().headers()["idempotency-key"] });
    expect(replay.body!.data.round.replayed).toBe(true);
    expect(replay.body!.data.order.items).toHaveLength(3);

    await page.getByRole("button", { name: /Request bill/ }).tap();
    await expect(page.getByRole("link", { name: "View bill" })).toBeVisible();
    const cashier = await apiAs("cashier");
    const alerts = await apiData<Array<{ type: string; title: string }>>(cashier, "/api/notifications");
    expect(alerts.some((a) => a.type === "BILL_REQUESTED" && a.title.includes("G1"))).toBe(true);
    const board = await apiData<{ tables: Array<{ code: string; status: string; tags: string[] }> }>(page.request, `/api/mobile/tables?outletId=${outlet.id}`);
    expect(board.tables.find((t) => t.code === "G1")).toMatchObject({ status: "BILL_REQUESTED", tags: expect.arrayContaining(["payment"]) });

    // The cashier collects (H1 payment path); the captain sees the order complete.
    const o = await apiData<{ total: string }>(cashier, `/api/orders/${orderId}`);
    const pay = await apiCall<{ id: string }>(cashier, "POST", "/api/payments", { orderId, method: "CASH", amount: Number(o.total) }, { "idempotency-key": `mob-pay-${RUN}` });
    expect((await apiCall(cashier, "POST", `/api/payments/${pay.body!.data.id}/verify`)).status).toBe(200);
    await page.getByRole("button", { name: /All tables/ }).tap();
    await page.reload();
    await expect(page.getByTestId("table-G1")).toContainText("Free");
    expect((await apiData<{ status: string }>(page.request, `/api/orders/${orderId}`)).status).toBe("PAID");
    const tables = await apiData<Array<{ id: string; status: string }>>(page.request, `/api/master/tables?outletId=${outlet.id}`);
    expect(tables.find((t) => t.id === table.id)?.status).toBe("AVAILABLE");
  });
});

test.describe("manager (phone)", () => {
  test.use({ storageState: statePath("manager") });

  test("MOB-002 today, live, alerts and staff administration", async ({ page }) => {
    await page.goto("/manager");
    await expect(page.getByText("Net sales")).toBeVisible();
    await expect(page.getByRole("list", { name: "Payment methods" }).or(page.getByText("No payments yet."))).toBeVisible();
    await page.getByRole("button", { name: /Live/ }).tap();
    await expect(page.getByText("Open orders")).toBeVisible();
    await expect(page.getByText("Tables occupied")).toBeVisible();
    await page.getByRole("button", { name: /Alerts/ }).tap();
    await expect(page.getByRole("region", { name: "Inventory alerts" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Finance alerts" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Insights" })).toContainText(/rules over/);

    await page.getByRole("button", { name: /Staff/ }).tap();
    await expect(page.getByRole("list", { name: "Staff members" })).toContainText("captain@demo.local");
    await page.getByRole("button", { name: /^Add$/ }).tap();
    const dlg = page.getByRole("dialog", { name: /staff/i });
    await dlg.getByLabel(/^Name/).fill(`Mobile Captain ${RUN}`);
    await dlg.getByLabel(/^Email/).fill(`mob-${RUN}@example.com`);
    await dlg.getByLabel(/^Role/).selectOption("CAPTAIN");
    await dlg.getByRole("button", { name: /Create|Add|Save/ }).tap();
    await confirmPasswordIfPrompted(page, page.getByRole("dialog", { name: "Password setup link" }));
    await expect(page.getByTestId("password-link")).toHaveValue(/\/set-password#token=/);
    await page.getByRole("button", { name: "Done" }).tap();
    const card = page.getByRole("list", { name: "Staff members" }).getByRole("listitem").filter({ hasText: `mob-${RUN}@example.com` });
    await card.getByRole("button", { name: "Deactivate" }).tap();
    await page.getByRole("dialog", { name: /Deactivate/ }).getByRole("button", { name: "Deactivate" }).tap();
    await confirmPasswordIfPrompted(page, card.getByText("Inactive"));
  });
});

test.describe("security (phone)", () => {
  test.use({ storageState: statePath("captain") });

  test("MOB-003 the server refuses what the role may not do", async ({ page }) => {
    const central = await outletByCode(page.request, CENTRAL);
    const jubilee = await outletByCode(await apiAs("owner"), "HYDJUB");
    await page.goto("/manager");
    await expect(page.getByText("Manager app not available")).toBeVisible();
    expect((await apiCall(page.request, "GET", `/api/mobile/tables?outletId=${jubilee.id}`)).status).toBe(403);
    expect((await apiCall(page.request, "POST", "/api/staff", { email: `x-${RUN}@example.com`, name: "X", role: "CAPTAIN", outletId: central.id })).status).toBe(403);
    expect((await apiCall(page.request, "GET", `/api/analytics/finance?outletId=${central.id}`)).status).toBe(403);
    const kitchen = await apiAs("kitchen");
    const placed = await apiCall<{ id: string }>(page.request, "POST", "/api/orders", { outletId: central.id, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: (await apiData<Array<{ id: string; name: string }>>(page.request, `/api/menu?outletId=${central.id}&activeOnly=true`)).find((m) => m.name === "Masala Chai")!.id, qty: 1 }] }, { "idempotency-key": `mob-sec-${RUN}` });
    expect(placed.status).toBe(200);
    expect((await apiCall(kitchen, "POST", `/api/orders/${placed.body!.data.id}/rounds`, { items: [{ menuItemId: "x", qty: 1 }] }, { "idempotency-key": `mob-k-${RUN}` })).status).toBe(403);
    expect((await apiCall(page.request, "POST", "/api/payments", { orderId: placed.body!.data.id, method: "CASH", amount: 1 }, { "idempotency-key": `mob-cp-${RUN}` })).status).toBe(403);
    const kitchenPage = await (await apiAs("kitchen")).get("/captain");
    expect(await kitchenPage.text()).toContain("Captain app not available");
  });
});
