// @vitest-environment jsdom
/**
 * Guest QR screens in a DOM: menu -> cart (modifiers, quantities) -> place
 * order (one request, idempotency key that survives a refresh, no prices sent),
 * server errors shown; order page (key from the URL fragment, header auth,
 * test-gateway approve / decline -> server confirmation); bill rendering; the
 * guest browser-state helpers.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuestMenuScreen, type GuestMenuData } from "@/features/guest/components/GuestMenuScreen";
import { GuestOrderScreen } from "@/features/guest/components/GuestOrderScreen";
import { BillView } from "@/features/billing/BillView";
import { loadCart, saveCart, submissionKey, clearSubmission, rememberOrder, rememberedOrders, orderKeyFor, orderUrl } from "@/features/guest/session";
import { cartReducer, emptyCart } from "@/features/pos/cart";
import type { Bill } from "@/server/services/bill";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let handler: (c: Call) => { status?: number; data?: unknown; error?: { code: string; message: string } };

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(c);
    const r = handler(c);
    if (r.error) return new Response(JSON.stringify({ ok: false, error: r.error }), { status: r.status ?? 422 });
    return new Response(JSON.stringify({ ok: true, data: r.data }), { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const menuData = (): GuestMenuData => ({
  restaurant: { name: "Spice Route", outletName: "Central", address: null, currency: "INR" },
  table: { code: "T4" },
  payment: { online: true, testMode: true },
  menu: [
    { id: "i-dosa", name: "Masala Dosa", description: "Crisp", price: 120, effectivePrice: 120, taxPct: 5, station: "KITCHEN", isVeg: true, active: true, offered: true, soldOut: false, effectiveSoldOut: false, categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [] },
    { id: "i-idli", name: "Idli", description: null, price: 60, effectivePrice: 60, taxPct: 5, station: "KITCHEN", isVeg: true, active: true, offered: true, soldOut: true, effectiveSoldOut: true, categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [] },
    {
      id: "i-biryani", name: "Biryani", description: null, price: 300, effectivePrice: 300, taxPct: 5, station: "KITCHEN", isVeg: false, active: true, offered: true, soldOut: false, effectiveSoldOut: false, categoryId: "c2", category: { id: "c2", name: "Mains", sortOrder: 2 },
      variants: [], modifierGroups: [{ group: { id: "g-spice", name: "Spice", minSelect: 1, maxSelect: 1, active: true, options: [{ id: "o-hot", name: "Hot", priceDelta: 0, active: true }, { id: "o-mild", name: "Mild", priceDelta: 0, active: true }] } }],
    },
  ],
});

describe("guest menu", () => {
  it("builds a cart with modifiers and places the order once — items only, never prices", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    handler = (c) => (c.method === "POST" ? { data: { orderId: "cmord1", ref: "ORD001", accessKey: "key-abc", replayed: false } } : { data: menuData() });
    render(<GuestMenuScreen token="tok-123456" initial={menuData()} navigate={navigate} />);

    expect(screen.getByLabelText("Table T4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Idli" })).toBeNull(); // sold out
    await user.click(screen.getByRole("button", { name: "Add Masala Dosa" }));
    await user.click(screen.getByRole("button", { name: "Add Masala Dosa" }));
    await user.click(screen.getByRole("button", { name: "Add Biryani" }));
    const dialog = await screen.findByRole("dialog", { name: "Biryani" });
    await user.click(within(dialog).getByRole("radio", { name: /Hot/ }));
    await user.click(within(dialog).getByRole("button", { name: /^Add/ }));

    await user.click(screen.getByRole("button", { name: /3 items .* View cart/ }));
    const cart = await screen.findByRole("dialog", { name: "Your order" });
    expect(within(cart).getByLabelText("Estimated total")).toHaveTextContent("567.00"); // (240 + 300) × 1.05
    await user.click(within(cart).getByRole("button", { name: "Place order" }));
    await user.click(within(cart).getByRole("button", { name: "Place order" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(orderUrl("cmord1", "key-abc")));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/qr/t/tok-123456/orders");
    expect(posts[0].headers["Idempotency-Key"]).toMatch(/^qr-/);
    expect(posts[0].body).toEqual({ items: [{ menuItemId: "i-dosa", qty: 2 }, { menuItemId: "i-biryani", modifierOptionIds: ["o-hot"], qty: 1 }] });
    expect(JSON.stringify(posts[0].body)).not.toMatch(/price|total|tax/i);
    expect(rememberedOrders()).toEqual([expect.objectContaining({ orderId: "cmord1", key: "key-abc", token: "tok-123456" })]);
    expect(loadCart("tok-123456").lines).toHaveLength(0);
  });

  it("shows the server's refusal and refreshes the menu; a retry reuses the same idempotency key", async () => {
    const user = userEvent.setup();
    let n = 0;
    handler = (c) => (c.method === "POST" ? (++n === 1 ? { status: 422, error: { code: "ValidationError", message: "Masala Dosa is sold out at this outlet" } } : { data: { orderId: "o2", ref: "R2", accessKey: "k2" } }) : { data: menuData() });
    render(<GuestMenuScreen token="tok-123456" initial={menuData()} navigate={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Add Masala Dosa" }));
    await user.click(screen.getByRole("button", { name: /View cart/ }));
    await user.click(screen.getByRole("button", { name: "Place order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("sold out");
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.url === "/api/qr/t/tok-123456")).toBe(true));
    await user.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
  });
});

const bill = (over: Partial<Bill> = {}): Bill => ({
  kind: "BILL", billNo: "ORD001", orderId: "cmord1",
  restaurant: { name: "Spice Route", outletName: "Central", address: "1 Road", phone: null, timezone: "Asia/Kolkata", currency: "INR" },
  table: "T4", channel: "QR", source: "QR", covers: 1, orderStatus: "SENT", fulfilment: "PREPARING", createdAt: "2026-10-04T08:00:00.000Z", paidAt: null,
  lines: [{ name: "Biryani", qty: "2", unitPrice: "300.00", modifiers: [{ name: "Spice: Hot", priceDelta: "0.00" }], discount: "0.00", taxPct: "5", lineTotal: "600.00", notes: null }],
  subtotal: "600.00", discount: "0.00", taxes: [{ ratePct: "5", taxable: "600.00", amount: "30.00" }], tax: "30.00", total: "630.00",
  payments: [], refunds: [], paid: "0.00", refunded: "0.00", balanceDue: "630.00", paymentStatus: "UNPAID", invoice: null, creditNotes: [], ...over,
});

describe("guest order page", () => {
  it("authenticates with the key from the URL fragment and pays through the server (decline, then approve)", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/o/cmord1#k=key-abc");
    const view = (over: object = {}) => ({ orderId: "cmord1", ref: "ORD001", status: "SENT", fulfilment: "PREPARING", fulfilmentLabel: "Being prepared", bill: bill(), canPay: true, payment: { online: true, testMode: true }, pendingPaymentId: null, ...over });
    let confirms = 0;
    handler = (c) => {
      if (c.url.endsWith("/payments/confirm")) {
        confirms++;
        return confirms === 1
          ? { data: { ...view(), paymentStatus: "FAILED" } }
          : { data: { ...view({ status: "PAID", canPay: false, bill: bill({ kind: "RECEIPT", paymentStatus: "PAID", paid: "630.00", balanceDue: "0.00", payments: [{ method: "ONLINE", status: "SUCCESS", amount: "630.00", at: "2026-10-04T08:10:00.000Z" }] }) }), paymentStatus: "SUCCESS" } };
      }
      if (c.url.endsWith("/payments")) return { data: { paymentId: `pay${confirms}`, amount: "630.00", provider: "mock", testMode: true } };
      return { data: view() };
    };
    render(<GuestOrderScreen orderId="cmord1" />);
    expect(await screen.findByTestId("order-stage")).toHaveTextContent("Being prepared");
    expect(calls[0]).toMatchObject({ url: "/api/qr/orders/cmord1" });
    expect(calls[0].headers["x-order-key"]).toBe("key-abc");
    expect(calls[0].url).not.toContain("key-abc");

    await user.click(screen.getByRole("button", { name: /Pay .*630\.00/ }));
    const gw = await screen.findByRole("region", { name: "Test payment gateway" });
    await user.click(within(gw).getByRole("button", { name: "Decline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("declined");
    await user.click(screen.getByRole("button", { name: /Pay .*630\.00/ }));
    await user.click(within(await screen.findByRole("region", { name: "Test payment gateway" })).getByRole("button", { name: "Approve payment" }));
    expect(await screen.findByText("Payment successful. Thank you!")).toBeInTheDocument();
    expect(screen.getByTestId("bill-payment-status")).toHaveTextContent("Paid");
    expect(screen.queryByRole("button", { name: /^Pay/ })).toBeNull();

    const confirmsSent = calls.filter((c) => c.url.endsWith("/payments/confirm")).map((c) => c.body);
    expect(confirmsSent).toEqual([{ paymentId: "pay0", gateway: { mockOutcome: "decline" } }, { paymentId: "pay1" }]);
    const starts = calls.filter((c) => c.url.endsWith("/payments"));
    expect(starts[0].body).toBeUndefined(); // the amount is the server's, never sent
    expect(starts[0].headers["Idempotency-Key"]).not.toBe(starts[1].headers["Idempotency-Key"]); // a new attempt after a decline
  });

  it("without a key it explains instead of calling the API", async () => {
    window.history.replaceState(null, "", "/o/other");
    handler = () => ({ data: null });
    render(<GuestOrderScreen orderId="other" />);
    expect(await screen.findByText("Order link incomplete")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe("bill view", () => {
  it("renders the server's amounts, modifiers, tax lines and payment state, and never claims a tax invoice", () => {
    render(<BillView bill={bill({ discount: "10.00", payments: [{ method: "CASH", status: "SUCCESS", amount: "100.00", at: "2026-10-04T08:05:00.000Z" }], paid: "100.00", balanceDue: "520.00", paymentStatus: "PARTIALLY_PAID" })} />);
    const doc = screen.getByRole("article", { name: "Bill ORD001" });
    expect(within(doc).getByText("+ Spice: Hot")).toBeInTheDocument();
    expect(within(doc).getByLabelText("Totals")).toHaveTextContent(/Tax 5% on ₹600\.00.*₹30\.00.*Total.*₹630\.00/);
    expect(within(doc).getByLabelText("Payments")).toHaveTextContent(/Balance due.*₹520\.00/);
    expect(screen.getByTestId("bill-payment-status")).toHaveTextContent("Partially paid");
    expect(doc).toHaveTextContent("not a tax invoice");
    expect(doc).not.toHaveTextContent(/GST|Tax invoice/);
  });
});

describe("guest browser state", () => {
  it("cart and submission key survive a refresh; a changed cart gets a new key", () => {
    const cart = cartReducer(emptyCart("DINE_IN"), { type: "add", line: { menuItemId: "m", name: "M", modifierOptionIds: [], modifierLabels: [], unitPrice: 1, modifiersPerUnit: 0, taxPct: 5, qty: 2 } });
    saveCart("t1", cart);
    expect(loadCart("t1").lines).toEqual(cart.lines);
    expect(loadCart("t2").lines).toEqual([]);
    const k = submissionKey("t1", "fp-a");
    expect(submissionKey("t1", "fp-a")).toBe(k);
    expect(submissionKey("t1", "fp-b")).not.toBe(k);
    clearSubmission("t1");
    expect(submissionKey("t1", "fp-b")).not.toBe(k);
  });

  it("remembers orders and prefers the fragment key", () => {
    rememberOrder({ orderId: "o1", key: "k1", token: "t", ref: "R1", at: "x" });
    expect(orderKeyFor("o1", "")).toBe("k1");
    expect(orderKeyFor("o1", "#k=k9")).toBe("k9");
    expect(orderKeyFor("o2", "")).toBeNull();
    localStorage.setItem("aharos.guest.orders", "{corrupt");
    expect(rememberedOrders()).toEqual([]);
  });
});
