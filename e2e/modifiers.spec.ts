import { test, expect, type Request } from "@playwright/test";
import { statePath, outletByCode, order, openPos, addSimpleItem, newItems, posCart, apiCall, apiData, CENTRAL } from "./helpers";

test.use({ storageState: statePath("cashier") });

/**
 * Fixture (e2e/prepare-db.ts): "E2E Pizza" ₹300, 5% tax
 *   variant Large +180
 *   "E2E Crust"    required, exactly 1: Thin +0, Stuffed +60
 *   "E2E Toppings" optional, up to 2:   Olive +30, Jalapeno +25, Corn +20
 */
const isOrderCreate = (r: Request) => r.method() === "POST" && new URL(r.url()).pathname === "/api/orders";

type MenuItem = { id: string; name: string; variants: Array<{ id: string; name: string }>; modifierGroups: Array<{ group: { id: string; name: string; options: Array<{ id: string; name: string }> } }> };

test.describe("modifiers", () => {
  test("MOD-001 required/min/max/optional/multiple rules in the dialog, priced by the server", async ({ page }) => {
    await openPos(page);
    await page.getByRole("radio", { name: "Takeaway" }).click();
    await addSimpleItem(page, "E2E Pizza");
    const dlg = page.getByRole("dialog", { name: "E2E Pizza" });
    await expect(dlg.getByText("Required · choose 1")).toBeVisible();
    await expect(dlg.getByText("Optional · up to 2")).toBeVisible();

    // Required group not satisfied -> inline error, nothing added.
    await dlg.getByRole("button", { name: /^Add · / }).click();
    await expect(dlg.getByRole("alert")).toHaveText("Choose at least 1");
    await expect(dlg).toBeVisible();
    await expect(newItems(page)).toHaveCount(0);

    // Single-choice group behaves as radios: picking another replaces the first.
    await dlg.getByRole("radio", { name: /^Thin/ }).click();
    await dlg.getByRole("radio", { name: /^Stuffed/ }).click();
    await expect(dlg.getByRole("radio", { name: /^Thin/ })).toHaveAttribute("aria-checked", "false");
    await expect(dlg.getByRole("radio", { name: /^Stuffed/ })).toHaveAttribute("aria-checked", "true");
    await expect(dlg.getByRole("alert")).toHaveCount(0);

    // Multi-select up to the max; the next option is disabled, unselecting re-enables it.
    await dlg.getByRole("checkbox", { name: /^Olive/ }).click();
    await dlg.getByRole("checkbox", { name: /^Jalapeno/ }).click();
    await expect(dlg.getByRole("checkbox", { name: /^Corn/ })).toBeDisabled();
    await dlg.getByRole("checkbox", { name: /^Jalapeno/ }).click();
    await expect(dlg.getByRole("checkbox", { name: /^Corn/ })).toBeEnabled();
    await dlg.getByRole("checkbox", { name: /^Jalapeno/ }).click();

    // Variant + quantity; the button shows the live price: (300+180+60+30+25) × 2.
    await dlg.getByRole("radio", { name: /^Large/ }).click();
    await dlg.getByRole("button", { name: "Increase quantity" }).click();
    await expect(dlg.getByRole("button", { name: "Add · ₹1,190.00" })).toBeVisible();
    await dlg.getByRole("button", { name: "Add · ₹1,190.00" }).click();
    await expect(dlg).toBeHidden();

    const line = newItems(page).getByRole("listitem");
    await expect(line).toHaveCount(1);
    await expect(line.getByText("E2E Pizza (Large)")).toBeVisible();
    // Cart labels are "<group>: <option>" in menu (group, option) order — summarizeSelection, pinned by tests/ui/logic.test.ts.
    await expect(line.getByText("E2E Crust: Stuffed, E2E Toppings: Jalapeno, E2E Toppings: Olive")).toBeVisible();
    await expect(line.getByText("₹1,190.00")).toBeVisible();

    const created = page.waitForResponse((r) => isOrderCreate(r.request()));
    await page.getByRole("button", { name: "Save" }).click();
    const res = await created;
    // API contract: every success is 200 with { ok, data } (src/server/api/router.ts; pinned by tests/api/routes.test.ts).
    expect(res.status()).toBe(200);
    const o = await order(page.request, ((await res.json()) as { data: { id: string } }).data.id);
    expect(o.items).toHaveLength(1);
    // Stored modifier names are "<group>: <option>" (pinned by tests/domain/pos-backend.test.ts).
    expect(o.items[0].modifiers.map((m) => m.name).sort()).toEqual(["E2E Crust: Stuffed", "E2E Toppings: Jalapeno", "E2E Toppings: Olive"]);
    expect(Number(o.items[0].qty)).toBe(2);
    expect(Number(o.items[0].lineTotal)).toBe(1190); // server re-priced, matching the dialog
  });

  test("MOD-002 optional group may be left empty", async ({ page }) => {
    await openPos(page);
    await page.getByRole("radio", { name: "Takeaway" }).click();
    await addSimpleItem(page, "E2E Pizza");
    const dlg = page.getByRole("dialog", { name: "E2E Pizza" });
    await dlg.getByRole("radio", { name: /^Thin/ }).click();
    await dlg.getByRole("button", { name: "Add · ₹300.00" }).click();
    await expect(newItems(page).getByRole("listitem")).toHaveCount(1);
    await expect(newItems(page).getByText("Thin")).toBeVisible();
    await expect(posCart(page).getByText("Estimate", { exact: true })).toBeVisible();
  });

  test("MOD-003 the server rejects invalid modifier selections (UI is not the only guard)", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const menu = await apiData<MenuItem[]>(page.request, `/api/menu?outletId=${outlet.id}&activeOnly=true`);
    const pizza = menu.find((m) => m.name === "E2E Pizza")!;
    const group = (n: string) => pizza.modifierGroups.find((g) => g.group.name === n)!.group;
    const opt = (g: string, n: string) => group(g).options.find((o) => o.name === n)!.id;
    const spice = menu.find((m) => m.name === "Chicken Biryani")!.modifierGroups[0].group.options[0].id;

    const place = (modifierOptionIds: string[], key: string) =>
      apiCall(page.request, "POST", "/api/orders", { outletId: outlet.id, channel: "TAKEAWAY", items: [{ menuItemId: pizza.id, qty: 1, modifierOptionIds }], submit: false }, { "Idempotency-Key": key });

    const cases: Array<[string, string[]]> = [
      ["missing required crust", [opt("E2E Toppings", "Olive")]],
      ["two crusts (max 1)", [opt("E2E Crust", "Thin"), opt("E2E Crust", "Stuffed")]],
      ["three toppings (max 2)", [opt("E2E Crust", "Thin"), opt("E2E Toppings", "Olive"), opt("E2E Toppings", "Jalapeno"), opt("E2E Toppings", "Corn")]],
      ["option from a group not attached to this item", [opt("E2E Crust", "Thin"), spice]],
      ["unknown option id", [opt("E2E Crust", "Thin"), "does-not-exist"]],
    ];
    const before = (await apiData<{ items: unknown[] }>(page.request, `/api/orders?outletId=${outlet.id}&take=100`)).items.length;
    for (const [i, [label, ids]] of cases.entries()) {
      const r = await place(ids, `e2e-mod-reject-${i}-0001`);
      expect.soft(r.status, label).toBe(422);
      expect.soft(r.body?.error?.message ?? "", label).not.toMatch(/prisma|stack|at \w+ \(/i);
    }
    // Atomic: a rejected line leaves no half-created order behind.
    const after = (await apiData<{ items: unknown[] }>(page.request, `/api/orders?outletId=${outlet.id}&take=100`)).items.length;
    expect(after).toBe(before);
  });
});
