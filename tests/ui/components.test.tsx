// @vitest-environment jsdom
/**
 * Component behaviour in a DOM: POS (menu -> cart -> submit, duplicate-submit
 * protection, idempotent retry), modifiers, payment validation and single
 * payment creation, KDS tickets + transitions, login. The network is a mocked
 * fetch that records every request (URL, method, headers, body).
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PosScreen } from "@/features/pos/components/PosScreen";
import { ModifierDialog } from "@/features/pos/components/ModifierDialog";
import { PaymentDialog } from "@/features/pos/components/PaymentDialog";
import { TicketCard } from "@/features/kitchen/components/TicketCard";
import { KitchenScreen } from "@/features/kitchen/components/KitchenScreen";
import { LoginForm, safeNext } from "@/app/login/LoginForm";
import type { MenuItemDTO } from "@/features/pos/types";
import type { KdsTicket } from "@/features/kitchen/kds";
import { ToastProvider } from "@/components/ui/Toast";

/** Same tree the /pos page renders (errors surface as toasts). */
const renderPos = () => render(<ToastProvider><PosScreen outletId="out1" perms={perms} /></ToastProvider>);

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/pos" }));

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
type Handler = (c: Call) => { status?: number; data?: unknown; error?: { code: string; message: string } } | "network";
let handler: Handler;

const ok = (data: unknown) => ({ data });

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(c);
    const r = handler(c);
    if (r === "network") throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    return new Response(JSON.stringify(status < 300 ? { ok: true, data: r.data } : { ok: false, error: r.error }), { status, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (over: Partial<MenuItemDTO> = {}): MenuItemDTO => ({
  id: "i-dosa", name: "Masala Dosa", description: null, price: "120", taxPct: "5", station: "KITCHEN", isVeg: true, active: true, soldOut: false,
  categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [], effectivePrice: 120, offered: true, effectiveSoldOut: false, ...over,
});

const pizza = item({
  id: "i-pizza", name: "Margherita", effectivePrice: 300, price: "300", taxPct: "5",
  variants: [{ id: "v-large", name: "Large", priceDelta: "180", active: true }],
  modifierGroups: [
    { group: { id: "crust", name: "Crust", minSelect: 1, maxSelect: 1, active: true, options: [{ id: "thin", name: "Thin", priceDelta: "0", active: true }, { id: "stuffed", name: "Stuffed", priceDelta: "60", active: true }] } },
    { group: { id: "top", name: "Toppings", minSelect: 0, maxSelect: 2, active: true, options: [{ id: "olive", name: "Olive", priceDelta: "30", active: true }, { id: "jal", name: "Jalapeno", priceDelta: "25", active: true }, { id: "corn", name: "Corn", priceDelta: "20", active: true }] } },
  ],
});

const perms = { pay: true, discount: true, cancel: true, customerView: true, customerManage: true };

function posBackend(overrides: Partial<Record<string, Handler>> = {}): Handler {
  return (c) => {
    for (const [prefix, h] of Object.entries(overrides)) if (`${c.method} ${c.url}`.startsWith(prefix)) return h!(c);
    if (c.url.startsWith("/api/menu")) return ok([item(), item({ id: "i-idli", name: "Idli", effectivePrice: 60, effectiveSoldOut: true })]);
    if (c.url.startsWith("/api/master/tables")) return ok([]);
    if (c.method === "GET" && c.url.startsWith("/api/orders?")) return ok({ items: [], nextCursor: null });
    if (c.method === "GET" && c.url.startsWith("/api/orders/")) {
      return ok({ id: c.url.replace("/api/orders/", "").split("?")[0], outletId: "out1", channel: "TAKEAWAY", status: "OPEN", tableId: null, customerId: null, customer: null, covers: 1, items: [], total: "126" });
    }
    if (c.method === "POST" && c.url === "/api/orders") return ok({ id: "cmorder000123", outletId: "out1", channel: "TAKEAWAY", status: "SENT", tableId: null, items: [], total: "126" });
    return { status: 404, error: { code: "NotFound", message: "no mock" } };
  };
}

describe("POS", () => {
  it("builds a cart from the real menu, blocks sold-out items, and submits once with an idempotency key", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = posBackend({ "POST /api/orders": (c) => { void gate; return ok({ id: "cmorder000123", tableId: null, status: "SENT", items: [], total: "252", body: c.body }); } });
    renderPos();

    const dosa = await screen.findByRole("button", { name: /Masala Dosa/ });
    expect(screen.getByRole("button", { name: /Idli.*sold out/ })).toBeDisabled();
    await user.click(dosa);
    await user.click(dosa);
    const cart = screen.getByRole("list", { name: "New items" });
    expect(within(cart).getByLabelText("Quantity of Masala Dosa")).toHaveValue("2");
    await user.click(screen.getByRole("button", { name: "Increase Masala Dosa" }));
    await user.click(screen.getByRole("button", { name: "Decrease Masala Dosa" }));
    expect(screen.getByText("Estimate").nextSibling).toHaveTextContent("252.00"); // 2 × 120 + 5%

    await user.click(screen.getByRole("radio", { name: "Takeaway" }));
    const send = screen.getByRole("button", { name: "Send to kitchen" });
    await user.click(send);
    await user.click(send); // double tap
    release();
    await waitFor(() => expect(screen.queryByRole("list", { name: "New items" })).toBeNull());

    const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/orders");
    expect(posts).toHaveLength(1);
    expect(posts[0].headers["Idempotency-Key"]).toMatch(/^pos-/);
    expect(posts[0].body).toMatchObject({ outletId: "out1", channel: "TAKEAWAY", submit: true, items: [{ menuItemId: "i-dosa", qty: 2 }] });
  });

  it("keeps the cart on a network failure and retries with the same idempotency key", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    handler = posBackend({ "POST /api/orders": () => (++attempt === 1 ? "network" : ok({ id: "cmorder000999", tableId: null, status: "SENT", items: [], total: "126" })) });
    renderPos();
    await user.click(await screen.findByRole("button", { name: /Masala Dosa/ }));
    await user.click(screen.getByRole("radio", { name: "Takeaway" }));
    await user.click(screen.getByRole("button", { name: "Send to kitchen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Network error/);
    expect(screen.getByRole("list", { name: "New items" })).toBeInTheDocument(); // not cleared
    await user.click(screen.getByRole("button", { name: "Send to kitchen" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "New items" })).toBeNull());
    const keys = calls.filter((c) => c.method === "POST" && c.url === "/api/orders").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("requires a table for dine-in and shows server validation errors", async () => {
    const user = userEvent.setup();
    handler = posBackend({ "POST /api/orders": () => ({ status: 422, error: { code: "ValidationError", message: "Masala Dosa is sold out at this outlet" } }) });
    renderPos();
    await user.click(await screen.findByRole("button", { name: /Masala Dosa/ }));
    await user.click(screen.getByRole("button", { name: "Send to kitchen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a table for dine-in");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(screen.getByRole("radio", { name: "Takeaway" }));
    await user.click(screen.getByRole("button", { name: "Send to kitchen" }));
    expect(await screen.findByText("Masala Dosa is sold out at this outlet")).toBeInTheDocument();
  });

  it("shows an error state (with retry) when the menu cannot load", async () => {
    handler = () => ({ status: 403, error: { code: "ForbiddenError", message: "Missing permission \"menu.view\"" } });
    renderPos();
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
  });

  it("restores a delivery customer after save, close and reopen", async () => {
    const user = userEvent.setup();
    const guest = { id: "c-asha", name: "Asha Rao", phone: "9000011111", email: null };
    const saved = {
      id: "cmorder-deliv", outletId: "out1", channel: "DELIVERY", status: "OPEN", tableId: null,
      customerId: guest.id, customer: guest, covers: 1,
      items: [{ id: "li1", name: "Masala Dosa", qty: "1", unitPrice: "120", lineTotal: "126", notes: null, menuItemId: "i-dosa", modifiers: [] }],
      total: "126", subtotal: "120", tax: "6", discount: "0",
    };
    handler = posBackend({
      "GET /api/customers": () => ok([guest]),
      "POST /api/orders": () => ok(saved),
      "GET /api/orders?": () => ok({ items: [{ ...saved, items: [{ id: "li1", name: "Masala Dosa", qty: "1", lineTotal: "126" }] }], nextCursor: null }),
      "GET /api/orders/cmorder-deliv": () => ok(saved),
    });
    renderPos();
    const cart = () => screen.getByRole("region", { name: "Current order" });
    await user.click(await screen.findByRole("radio", { name: "Delivery" }));
    await user.click(within(cart()).getByRole("button", { name: "Customer" }));
    const pick = await screen.findByRole("dialog", { name: "Customer" });
    await user.type(within(pick).getByPlaceholderText("Phone number"), "9000011111");
    await user.click(within(pick).getByRole("button", { name: "Find" }));
    await user.click(await within(pick).findByRole("button", { name: /Asha Rao/ }));
    await expect(within(cart()).getByRole("button", { name: "Asha Rao" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Masala Dosa/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await expect(await screen.findByRole("button", { name: "Asha Rao" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await expect(within(cart()).getByRole("button", { name: "Customer" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open orders" }));
    const open = await screen.findByRole("dialog", { name: "Open orders" });
    await user.click(within(open).getByRole("button", { name: /Asha Rao/ }));
    await expect(within(cart()).getByRole("button", { name: "Asha Rao" })).toBeVisible();
  });
});

describe("modifier dialog", () => {
  it("enforces required groups and max selections, and prices variant + modifiers", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<ModifierDialog item={pizza} onClose={() => undefined} onAdd={onAdd} />);
    const dialog = screen.getByRole("dialog", { name: "Margherita" });
    await user.click(within(dialog).getByRole("button", { name: /^Add/ }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose at least 1");
    expect(onAdd).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("radio", { name: /Large/ }));
    await user.click(within(dialog).getByRole("radio", { name: /Stuffed/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Olive/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Jalapeno/ }));
    expect(within(dialog).getByRole("checkbox", { name: /Corn/ })).toBeDisabled(); // max 2
    await user.click(within(dialog).getByRole("button", { name: "Increase quantity" }));
    await user.click(within(dialog).getByRole("button", { name: /^Add/ }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
      menuItemId: "i-pizza", variantId: "v-large", modifierOptionIds: ["stuffed", "olive", "jal"], unitPrice: 480, modifiersPerUnit: 115, qty: 2, name: "Margherita (Large)",
    }));
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ModifierDialog item={pizza} onClose={onClose} onAdd={() => undefined} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("payment dialog", () => {
  const order = { id: "cmorder000123", total: "756", status: "SENT", payments: [], items: [], subtotal: "720", tax: "36", discount: "0" };

  it("validates against the balance due and computes change", async () => {
    const user = userEvent.setup();
    handler = () => ok(order);
    render(<PaymentDialog orderId="cmorder000123" onClose={() => undefined} onSettled={() => undefined} />);
    const input = await screen.findByLabelText("Cash received");
    await user.clear(input);
    await user.type(input, "1000");
    expect(screen.getByText("Change to return: ₹244.00")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Card" }));
    const amount = screen.getByLabelText("Amount to charge");
    await user.clear(amount);
    await user.type(amount, "800");
    expect(screen.getByText("Amount exceeds the balance due")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Charge/ })).toBeDisabled();
  });

  function paymentBackend(failFirstVerify: boolean): Handler {
    let verifies = 0;
    return (c) => {
      if (c.method === "GET") return ok(verifies > (failFirstVerify ? 1 : 0) ? { ...order, status: "PAID", payments: [{ id: "p1", status: "SUCCESS", amount: "756" }] } : order);
      if (c.url === "/api/payments") return ok({ id: "p1", status: "PENDING", amount: "756", method: "CASH" });
      if (c.url === "/api/payments/p1/verify") return ++verifies === 1 && failFirstVerify ? "network" : ok({ payment: { id: "p1", status: "SUCCESS", amount: "756" }, orderSettled: true });
      return { status: 404, error: { code: "x", message: "x" } };
    };
  }

  it("a double click creates exactly one payment", async () => {
    const user = userEvent.setup();
    handler = paymentBackend(false);
    const onSettled = vi.fn();
    render(<PaymentDialog orderId="cmorder000123" onClose={() => undefined} onSettled={onSettled} />);
    await user.dblClick(await screen.findByRole("button", { name: /Charge/ }));
    expect(await screen.findByText("Paid in full")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/payments")).toHaveLength(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("a failed confirmation retries the SAME payment instead of charging again", async () => {
    const user = userEvent.setup();
    handler = paymentBackend(true);
    const onSettled = vi.fn();
    render(<PaymentDialog orderId="cmorder000123" onClose={() => undefined} onSettled={onSettled} />);
    await user.click(await screen.findByRole("button", { name: /Charge/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not charge the guest again/);
    expect(screen.queryByRole("button", { name: /Charge/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry confirmation" }));
    expect(await screen.findByText("Paid in full")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/payments")).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/payments/p1/verify")).toHaveLength(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

const ticket = (over: Partial<KdsTicket> = {}): KdsTicket => ({
  id: "k1", number: 42, status: "NEW", createdAt: new Date(Date.now() - 12 * 60000).toISOString(), orderId: "cmorder000123", station: { id: "s1", name: "Main" },
  order: { id: "cmorder000123", channel: "DINE_IN", source: "POS", covers: 4, notes: "Birthday", createdAt: "", table: { code: "T6" } },
  items: [{ id: "ki1", name: "Margherita (Large)", qty: "2", status: "NEW", notes: null, orderItem: { notes: "well done", modifiers: [{ name: "Crust: Stuffed" }] } }],
  ...over,
});

describe("KDS", () => {
  it("renders a ticket with table, age, items, modifiers and notes, and triggers the next transition", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<TicketCard ticket={ticket()} now={Date.now()} pending={false} canUpdate onAction={onAction} />);
    const card = screen.getByRole("article", { name: "KOT 42, Table T6" });
    expect(card).toHaveTextContent("4 pax");
    expect(card).toHaveTextContent("2 × Margherita (Large)");
    expect(card).toHaveTextContent("Crust: Stuffed");
    expect(card).toHaveTextContent("“well done”");
    expect(card).toHaveTextContent("Order note: Birthday");
    expect(within(card).getByLabelText("Waiting 12m")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Accept" }));
    expect(onAction).toHaveBeenCalledWith("ACCEPTED");
  });

  it("hides actions for view-only roles", () => {
    render(<TicketCard ticket={ticket({ status: "READY" })} now={Date.now()} pending={false} canUpdate={false} onAction={() => undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("polls tickets into columns and refreshes from the server after an action", async () => {
    const user = userEvent.setup();
    let status: KdsTicket["status"] = "NEW";
    handler = (c) => {
      if (c.url.startsWith("/api/kitchen/stations")) return ok([{ id: "s1", name: "Main", kind: "KITCHEN" }]);
      if (c.url.startsWith("/api/kitchen/kots?")) return ok([ticket({ status })]);
      if (c.url === "/api/kitchen/kots/k1/status") {
        status = (c.body as { status: KdsTicket["status"] }).status;
        return ok({ id: "k1", status });
      }
      return { status: 404, error: { code: "x", message: "x" } };
    };
    render(<ToastProvider><KitchenScreen outletId="out1" canUpdate /></ToastProvider>);
    const newCol = await screen.findByRole("region", { name: /New/ });
    expect(await within(newCol).findByText("KOT 42")).toBeInTheDocument();
    await user.click(within(newCol).getByRole("button", { name: "Accept" }));
    const progress = screen.getByRole("region", { name: /In progress/ });
    expect(await within(progress).findByText("KOT 42")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/kitchen/kots/k1/status")?.body).toEqual({ status: "ACCEPTED" });

    await user.selectOptions(screen.getByLabelText("Station"), "s1");
    await waitFor(() => expect(calls.some((c) => c.url.includes("stationId=s1"))).toBe(true));
  });

  it("shows a forbidden error instead of a blank board", async () => {
    handler = (c) => (c.url.startsWith("/api/kitchen/stations") ? ok([]) : { status: 403, error: { code: "ForbiddenError", message: "Missing permission" } });
    render(<ToastProvider><KitchenScreen outletId="out1" canUpdate={false} /></ToastProvider>);
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
  });
});

describe("login", () => {
  it("shows the server's error and never redirects off-site", async () => {
    const user = userEvent.setup();
    handler = () => ({ status: 401, error: { code: "UnauthorizedError", message: "Invalid email or password" } });
    render(<LoginForm next="//evil.example" />);
    await user.type(screen.getByLabelText("Email"), "a@b.co");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    // Bad credentials must read as bad credentials, not "session ended" (found in browser E2E LOGIN-002).
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(safeNext("//evil.example")).toBe("/dashboard");
    expect(safeNext(`/${String.fromCharCode(92)}evil.example`)).toBe("/dashboard"); // browsers read "/\\" as "//" (found in E2E hardening)
    expect(safeNext("/pos")).toBe("/pos");

    handler = () => ok({ user: {} });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Sign in" }));
    });
    expect(router.replace).toHaveBeenCalledWith("/dashboard");
  });
});
