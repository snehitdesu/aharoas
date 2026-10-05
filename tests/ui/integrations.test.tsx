// @vitest-environment jsdom
/**
 * Phase 7 screens in a DOM: connections show their real mode (MOCK / SANDBOX /
 * LIVE) and health, secrets are never displayed and the save posts them
 * write-only; the outbox offers retry for failed deliveries; printers show
 * simulated vs network, test print and retry; the receipt page's printer
 * actions dedupe and ask a reason for reprints.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntegrationsScreen, PrintersScreen } from "@/features/backoffice/integrations";
import { PrinterActions } from "@/features/billing/PrinterActions";
import { state, installFetch, teardown, renderAs, posts } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/settings/integrations" }));
beforeEach(installFetch);
afterEach(teardown);

const at = "2026-10-05T06:30:00.000Z";
const connections = [
  { id: "c1", kind: "PAYMENT", provider: "razorpay", outletId: null, externalRef: "acc_1", status: "CONNECTED", mode: "SANDBOX", declaredMode: "SANDBOX", configured: true, hasWebhookSecret: true, hasCredentials: false, config: null, lastCheckedAt: at, lastSuccessAt: at, lastFailureAt: null, lastError: null },
  { id: "c2", kind: "MESSAGING", provider: "mock", outletId: null, externalRef: null, status: "CONNECTED", mode: "MOCK", declaredMode: "SANDBOX", configured: true, hasWebhookSecret: false, hasCredentials: false, config: { channel: "SMS", templates: { PAYMENT_RECEIVED: true } }, lastCheckedAt: null, lastSuccessAt: null, lastFailureAt: at, lastError: "Provider unreachable" },
];

describe("integrations screen", () => {
  it("shows modes and health; tests a connection; never shows a secret; saves credentials write-only", async () => {
    state.routes = {
      "GET /api/integrations": () => ({ connections, deployment: { payment: { provider: "mock", mode: "MOCK", configured: true, note: "Test gateway — no money moves" }, mockProvidersAllowed: true } }),
      "POST /api/integrations/c1/test": () => connections[0],
      "POST /api/integrations": () => ({ id: "c3" }),
    };
    renderAs(<IntegrationsScreen />, ["integration.manage"]);
    const table = await screen.findByRole("table", { name: "Connections" });
    const pay = within(table).getByText("razorpay").closest("tr")!;
    expect(pay).toHaveTextContent("SANDBOX");
    const msg = within(table).getAllByText("mock")[0].closest("tr")!;
    expect(msg).toHaveTextContent("MOCK");
    expect(msg).toHaveTextContent("Provider unreachable");
    expect(screen.getByTestId("deployment-payment")).toHaveTextContent("Test gateway — no money moves");
    await userEvent.click(within(pay).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/integrations/c1/test")).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: /Connect/ }));
    const dlg = await screen.findByRole("dialog", { name: "Connect an integration" });
    await userEvent.type(within(dlg).getByLabelText(/Account SID/), `AC${"d".repeat(32)}`);
    await userEvent.type(within(dlg).getByLabelText(/Auth token/), "secret-token-value-123456");
    expect(within(dlg).getByLabelText(/Auth token/)).toHaveAttribute("type", "password");
    await userEvent.click(within(dlg).getByRole("checkbox", { name: "Payment received" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/integrations" && p.method === "POST")).toBe(true));
    const sent = posts().find((p) => p.path === "/api/integrations" && p.method === "POST")!;
    expect(sent.body).toMatchObject({ kind: "MESSAGING", provider: "twilio", mode: "SANDBOX", credentials: { authToken: "secret-token-value-123456" }, config: { templates: { PAYMENT_RECEIVED: true, ORDER_READY: false } } });
  });

  it("outbox lists deliveries with masked targets and retries failed ones", async () => {
    state.routes = {
      "GET /api/integrations": () => ({ connections, deployment: { payment: { provider: "mock", mode: "MOCK", configured: true }, mockProvidersAllowed: true } }),
      "GET /api/integrations/deliveries": () => [{ id: "d1", kind: "MESSAGE", provider: "twilio", mode: "SANDBOX", target: "+91******3210", status: "FAILED", attempts: 1, maxAttempts: 3, lastError: "Provider returned 503", sourceType: "Order", sourceId: "o1", createdAt: at, sentAt: null }],
      "POST /api/integrations/deliveries/d1/retry": () => ({}),
    };
    renderAs(<IntegrationsScreen />, ["integration.manage"]);
    await userEvent.click(await screen.findByRole("tab", { name: "Outbox" }));
    const row = (await screen.findByText("+91******3210")).closest("tr")!;
    expect(row).toHaveTextContent("Provider returned 503");
    await userEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/integrations/deliveries/d1/retry")).toBe(true));
  });
});

describe("printers screen + receipt actions", () => {
  it("lists printers with their mode, runs a test print and retries a failed job", async () => {
    state.routes = {
      "GET /api/print/printers": () => [
        { id: "p1", name: "Front", role: "RECEIPT", station: null, transport: "NETWORK_ESCPOS", host: "192.168.1.50", port: 9100, width: 42, cashDrawer: true, autoPrint: true, active: true, lastStatus: "OFFLINE", lastError: "Printer unreachable", lastSeenAt: null, mode: "LIVE" },
        { id: "p2", name: "Sim", role: "KOT", station: "BAR", transport: "SIMULATED", host: null, port: 9100, width: 32, cashDrawer: false, autoPrint: true, active: true, lastStatus: "ONLINE", lastError: null, lastSeenAt: at, mode: "MOCK" },
      ],
      "GET /api/print/jobs": () => [{ id: "j1", kind: "RECEIPT", status: "FAILED", attempts: 1, lastError: "Printer unreachable", printerId: "p1", sourceType: "Order", sourceId: "o1", reason: null, createdAt: at, printedAt: null }],
      "POST /api/print/printers/p1/test": () => ({ status: "FAILED" }),
      "POST /api/print/jobs/j1/retry": () => ({ status: "PRINTED" }),
    };
    renderAs(<PrintersScreen />, ["outlet.manage", "payment.take", "order.view"]);
    const printers = await screen.findByRole("table", { name: "Printers" });
    expect(within(printers).getByText("Front").closest("tr")).toHaveTextContent("192.168.1.50:9100");
    expect(within(printers).getByText("Sim").closest("tr")).toHaveTextContent("MOCK");
    await userEvent.click(within(within(printers).getByText("Front").closest("tr")!).getByRole("button", { name: "Test print" }));
    const jobs = await screen.findByRole("table", { name: "Print jobs" });
    await userEvent.click(within(jobs).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(posts().map((p) => p.path)).toEqual(expect.arrayContaining(["/api/print/printers/p1/test", "/api/print/jobs/j1/retry"])));
  });

  it("receipt: the first send dedupes, a reprint needs a reason", async () => {
    let n = 0;
    state.routes = { "POST /api/print/orders/o9/receipt": (c) => (c.body?.reprint ? { status: "PRINTED", duplicate: false, lastError: null } : ++n === 1 ? { status: "PRINTED", duplicate: false, lastError: null } : { status: "PRINTED", duplicate: true, lastError: null }) };
    renderAs(<PrinterActions orderId="o9" />, ["order.view"]);
    await userEvent.click(screen.getByRole("button", { name: "Send to printer" }));
    expect(await screen.findByText("Printed.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send to printer" }));
    expect(await screen.findByText(/Already sent to the printer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reprint" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reprint reason"), "Guest copy");
    await userEvent.click(screen.getByRole("button", { name: "Reprint" }));
    await waitFor(() => expect(posts().at(-1)!.body).toEqual({ reprint: true, reason: "Guest copy" }));
  });
});
