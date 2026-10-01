/**
 * Back-office workflows a manager runs every week, through the real screens:
 *  - procurement: purchase order → submit → approve → ordered → receive (GRN) → post → stock in
 *  - inventory: wastage draft → post → stock out
 *  - finance: record an expense → it reaches the expense list and the P&L
 *  - reports: the expense shows in the Expenses report and in its CSV download
 * Server state (stock, ledger, statuses, P&L) is read back through the API.
 */
import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { statePath, outletByCode, materialByName, stockQty, apiData, CENTRAL } from "./helpers";

test.use({ storageState: statePath("manager") });

const RUN = Date.now().toString(36);
const statusBadge = (page: Page, status: string) => page.getByRole("heading", { level: 1 }).locator("..").getByText(status, { exact: true });

async function transition(page: Page, label: string, next: string, confirm?: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  if (confirm) await page.getByRole("dialog", { name: confirm }).getByRole("button", { name: "Confirm" }).click();
  await expect(statusBadge(page, next)).toBeVisible();
}

test.describe("back office operations", () => {
  test("PROC-001 purchase order through goods receipt puts stock on the ledger", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const cashew = await materialByName(page.request, "Cashew");
    const before = await stockQty(page.request, outlet.id, cashew.id);

    await page.goto("/procurement/purchase-orders");
    await page.getByRole("button", { name: "New PO" }).click();
    const dlg = page.getByRole("dialog", { name: "New purchase order" });
    await dlg.getByLabel(/^Vendor/).selectOption({ label: "Karachi Bakery Supplies" });
    await dlg.getByLabel("Notes").fill(`E2E ${RUN}`);
    await dlg.getByLabel("Line 1 material").selectOption(cashew.id);
    await dlg.getByLabel("Line 1 Qty").fill("5");
    await dlg.getByLabel("Line 1 Rate").fill("790");
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/procurement/purchase-orders");
    await dlg.getByRole("button", { name: "Create PO" }).click();
    const po0 = ((await (await created).json()) as { data: { id: string; number: string } }).data;
    await expect(dlg).toBeHidden();
    // The list reloads with the new draft; open it from there.
    await page.getByRole("table", { name: "Purchase orders" }).getByText(po0.number, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/procurement/purchase-orders/${po0.id}$`));
    const poId = po0.id;
    await expect(statusBadge(page, "Draft")).toBeVisible();

    await transition(page, "Submit", "Submitted");
    await transition(page, "Approve", "Approved");
    await transition(page, "Mark ordered", "Ordered");

    await page.getByRole("button", { name: "Receive (GRN)" }).click();
    const grn = page.getByRole("dialog", { name: /^Receive against PO/ });
    await expect(grn.getByLabel("Line 1 Qty received")).toHaveValue("5"); // prefilled with what is outstanding
    await grn.getByRole("button", { name: "Create GRN (draft)" }).click();
    await expect(page).toHaveURL(/\/procurement\/grns\/[^/]+$/);
    // Draft GRN: nothing on the ledger yet.
    expect(await stockQty(page.request, outlet.id, cashew.id)).toBeCloseTo(before, 5);
    await transition(page, "Post to inventory", "Posted", "Post this GRN?");

    expect(await stockQty(page.request, outlet.id, cashew.id)).toBeCloseTo(before + 5, 5);
    const po = await apiData<{ status: string; lines: Array<{ receivedQty: string }> }>(page.request, `/api/procurement/purchase-orders/${poId}`);
    expect(po.status).toBe("RECEIVED");
    expect(Number(po.lines[0].receivedQty)).toBe(5);

    // The movement is visible on the material's stock screen, linked to its source.
    await page.goto(`/inventory/stock/${cashew.id}`);
    await expect(page.getByRole("table", { name: "Inventory ledger" }).getByText("Purchase receipt").first()).toBeVisible();
  });

  test("INV-001 posting wastage deducts stock once; the draft does not", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const tomato = await materialByName(page.request, "Tomato");
    const before = await stockQty(page.request, outlet.id, tomato.id);

    await page.goto("/inventory/wastage");
    await page.getByRole("button", { name: "Record wastage" }).click();
    const dlg = page.getByRole("dialog", { name: "Record wastage" });
    await dlg.getByLabel("Notes").fill(`E2E spoilt crate ${RUN}`);
    await dlg.getByLabel("Line 1 material").selectOption(tomato.id);
    await dlg.getByLabel("Line 1 Qty").fill("1.5");
    await dlg.getByRole("button", { name: "Save draft" }).click();
    await expect(page).toHaveURL(/\/inventory\/wastage\/[^/]+$/);
    expect(await stockQty(page.request, outlet.id, tomato.id)).toBeCloseTo(before, 5);

    await transition(page, "Post wastage", "Posted", "Post this wastage?");
    expect(await stockQty(page.request, outlet.id, tomato.id)).toBeCloseTo(before - 1.5, 5);
    await expect(page.getByRole("button", { name: "Post wastage" })).toHaveCount(0); // one-shot
  });

  test("FIN-001 an expense reaches the expense list and the P&L; REPORT-001 and the Expenses report + CSV", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const pnlUrl = `/api/finance/pnl?outletId=${outlet.id}&from=${new Date(Date.now() - 2 * 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}`;
    const pnlBefore = await apiData<{ expenses: number }>(page.request, pnlUrl);

    await page.goto("/finance/expenses");
    await page.getByRole("button", { name: /Record expense/ }).click();
    const dlg = page.getByRole("dialog", { name: "Record expense" });
    await dlg.getByLabel(/^Amount/).fill("1234.50");
    await dlg.getByLabel("Description").fill(`E2E electricity ${RUN}`);
    await dlg.getByRole("button", { name: "Save expense" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("table", { name: "Expenses" }).getByText(`E2E electricity ${RUN}`)).toBeVisible();
    const pnlAfter = await apiData<{ expenses: number }>(page.request, pnlUrl);
    expect(pnlAfter.expenses - pnlBefore.expenses).toBeCloseTo(1234.5, 2);

    // Reports: the Expenses report lists it, and the CSV export contains it.
    await page.goto("/reports");
    await page.getByLabel("Report").selectOption({ label: "Expenses" });
    const report = page.getByRole("table", { name: "Expenses" });
    await expect(report.getByText(`E2E electricity ${RUN}`)).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    const file = await (await download).path();
    const csv = fs.readFileSync(file!, "utf8");
    expect(csv.split(/\r?\n/)[0]).toMatch(/,/); // header row
    expect(csv).toContain(`E2E electricity ${RUN}`);
    expect(csv).toContain("1234.5");
  });
});
