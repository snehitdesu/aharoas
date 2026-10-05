// @vitest-environment jsdom
/**
 * H3 step-up re-authentication UI: a sensitive request answered with
 * ReauthRequiredError opens the "Confirm your password" dialog (ReauthProvider),
 * the password goes ONLY in a POST body to /api/auth/reauth, and the original
 * request is retried exactly once — and only after the server issued a grant.
 * The network is a mocked fetch that models the server's gate.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReauthProvider } from "@/components/auth/ReauthProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { ActionButton } from "@/components/ui/Confirm";
import { api, ApiError, REAUTH_CANCELLED_MESSAGE } from "@/lib/api/client";

const PASSWORD = "Owner#Pass42";
/** For calls that must fail: the error, typed; a success fails the test. */
const unexpected = (): ApiError => { throw new Error("expected the call to fail"); };
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[];
/** Server model: scopes granted to "this session"; refunds actually performed. */
let granted: Set<string>;
let performed: number;
let reauthStatus: number | null; // force /api/auth/reauth to answer this status
let expireAfterGrant: boolean; // the grant expires before the retry lands

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reauthRequired = (scope: string, label: string) => json(403, { ok: false, error: { code: "ReauthRequiredError", message: `Confirm your password to ${label}`, details: { scope } } });

beforeEach(() => {
  calls = [];
  granted = new Set();
  performed = 0;
  reauthStatus = null;
  expireAfterGrant = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(c);
    if (url === "/api/auth/reauth") {
      if (reauthStatus === 401) return json(401, { ok: false, error: { code: "UnauthorizedError", message: "Unauthorized" } });
      if (reauthStatus === 429) return new Response(JSON.stringify({ ok: false, error: { code: "RateLimited", message: "Too many" } }), { status: 429, headers: { "retry-after": "30" } });
      if (c.body?.password !== PASSWORD) return json(422, { ok: false, error: { code: "ValidationError", message: "Password is incorrect" } });
      if (!expireAfterGrant) granted.add(c.body.scope);
      return json(200, { ok: true, data: { scope: c.body.scope, expiresAt: new Date(Date.now() + 300_000).toISOString() } });
    }
    if (url === "/api/payments/p1/refund") {
      if (!granted.has("payment.refund")) return reauthRequired("payment.refund", "issue a refund");
      performed++;
      return json(200, { ok: true, data: { id: `r${performed}` } });
    }
    if (url === "/api/staff/memberships") {
      if (!granted.has("staff.manage")) return reauthRequired("staff.manage", "change staff accounts or roles");
      performed++;
      return json(200, { ok: true, data: { id: "m1" } });
    }
    if (url === "/api/staff/forbidden") return json(403, { ok: false, error: { code: "ForbiddenError", message: 'Missing permission "staff.manage"' } });
    return json(404, { ok: false, error: { code: "NotFoundError", message: "no mock" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as { aharosDesktop?: unknown }).aharosDesktop;
});

const refundCalls = () => calls.filter((c) => c.url === "/api/payments/p1/refund");
const reauthCalls = () => calls.filter((c) => c.url === "/api/auth/reauth");

/** A protected action exactly as the back office wires it (ActionButton → api()). */
function RefundButton({ onDone }: { onDone?: () => void }) {
  return (
    <ActionButton variant="danger" action={() => api("/api/payments/p1/refund", { method: "POST", body: { amount: 40, reason: "cold" }, idempotencyKey: "idem-1" })} success="Refund issued" onDone={onDone}>
      Refund
    </ActionButton>
  );
}
const renderApp = (ui: React.ReactNode) => render(<ToastProvider><ReauthProvider>{ui}</ReauthProvider></ToastProvider>);
const dialog = () => screen.findByRole("dialog", { name: "Confirm your password" });

describe("ReauthProvider: protected action → password dialog", () => {
  it("opens the dialog with the reason; the correct password performs the action exactly once", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    renderApp(<RefundButton onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    const d = await dialog();
    expect(d).toHaveTextContent("Confirm your password to issue a refund.");
    expect(performed).toBe(0);

    const field = screen.getByLabelText("Current password");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "current-password");
    await user.type(field, PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Refund issued")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(performed).toBe(1);
    // One refused attempt (the gate runs before the action) + exactly one retry.
    expect(refundCalls()).toHaveLength(2);
    // The retry is the SAME request: same body, same Idempotency-Key, no client-side "reauth" claim.
    expect(refundCalls()[1].body).toEqual(refundCalls()[0].body);
    expect(refundCalls()[1].headers["Idempotency-Key"]).toBe("idem-1");
    expect(JSON.stringify(refundCalls()[1])).not.toMatch(/reauth|password/i);
  });

  it("sends the password only in a POST body to /api/auth/reauth — never in a URL, never logged — and clears it", async () => {
    const user = userEvent.setup();
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k));
    renderApp(<RefundButton />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.type(screen.getByLabelText("Current password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(performed).toBe(1));

    expect(reauthCalls()).toHaveLength(1);
    expect(reauthCalls()[0]).toMatchObject({ method: "POST", body: { password: PASSWORD, scope: "payment.refund" } });
    for (const c of calls) expect(c.url).not.toContain(PASSWORD);
    for (const spy of logs) for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain(PASSWORD);
    expect(JSON.stringify(window.localStorage)).not.toContain(PASSWORD);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(PASSWORD);
    expect(document.cookie).not.toContain(PASSWORD);
    expect(document.body.innerHTML).not.toContain(PASSWORD);

    // Re-opening later starts with an empty field.
    granted.clear();
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    logs.forEach((s) => s.mockRestore());
  });

  it("cancel leaves data unchanged and does not retry", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    renderApp(<RefundButton onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.type(screen.getByLabelText("Current password"), "half-typed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(REAUTH_CANCELLED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(performed).toBe(0);
    expect(refundCalls()).toHaveLength(1);
    expect(reauthCalls()).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain("half-typed");
  });

  it("Escape and the close button also cancel", async () => {
    const user = userEvent.setup();
    renderApp(<RefundButton />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(performed).toBe(0);
    expect(refundCalls()).toHaveLength(2);
  });

  it("a wrong password leaves data unchanged, clears the field and lets the user try again", async () => {
    const user = userEvent.setup();
    renderApp(<RefundButton />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.type(screen.getByLabelText("Current password"), "Wrong#Pass1");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("That password is incorrect. Nothing was changed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(performed).toBe(0);
    expect(refundCalls()).toHaveLength(1); // no retry without a grant

    await user.type(screen.getByLabelText("Current password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(performed).toBe(1));
    expect(refundCalls()).toHaveLength(2);
  });

  it("an expired grant: the single retry fails, the error is shown, and nothing retries again", async () => {
    const user = userEvent.setup();
    expireAfterGrant = true; // the server says "granted" but the grant is gone by the time the retry arrives
    renderApp(<RefundButton />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.type(screen.getByLabelText("Current password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Confirm your password to issue a refund")).toBeInTheDocument(); // toast
    await new Promise((r) => setTimeout(r, 50));
    expect(refundCalls()).toHaveLength(2); // original + ONE retry, no loop
    expect(reauthCalls()).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(performed).toBe(0);
  });

  it("an ended/revoked session: the dialog says so, offers sign-in, and the action reports the ended session", async () => {
    const user = userEvent.setup();
    reauthStatus = 401;
    renderApp(<RefundButton />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.type(screen.getByLabelText("Current password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Your session has ended. Sign in again to continue/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", expect.stringMatching(/^\/login\?next=/));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Your session has ended. Please sign in again.")).toBeInTheDocument();
    expect(performed).toBe(0);
    expect(refundCalls()).toHaveLength(1);
  });

  it("rate limiting is reported without retrying the action", async () => {
    const user = userEvent.setup();
    reauthStatus = 429;
    renderApp(<RefundButton />);
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await dialog();
    await user.type(screen.getByLabelText("Current password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Too many attempts. Try again in 30s.")).toBeInTheDocument();
    expect(refundCalls()).toHaveLength(1);
  });

  it("concurrent requests needing the same scope share one dialog and one password check", async () => {
    const user = userEvent.setup();
    renderApp(<span />);
    let a!: Promise<unknown>, b!: Promise<unknown>;
    act(() => {
      a = api("/api/staff/memberships", { method: "POST", body: { userId: "u1", role: "MANAGER" } });
      b = api("/api/staff/memberships", { method: "POST", body: { userId: "u2", role: "CASHIER" } });
    });
    await dialog();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveTextContent("Confirm your password to change staff accounts or roles.");
    await user.type(screen.getByLabelText("Current password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await Promise.all([a, b]);
    expect(reauthCalls()).toHaveLength(1);
    expect(performed).toBe(2); // each original request performed once
  });

  it("a non-reauth 403 (missing permission) never opens the dialog", async () => {
    renderApp(<span />);
    const err = await api("/api/staff/forbidden", { method: "POST" }).then(unexpected, (e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("ForbiddenError");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(reauthCalls()).toHaveLength(0);
  });

  it("works on top of an existing confirmation dialog (Esc only closes the topmost)", async () => {
    const user = userEvent.setup();
    renderApp(
      <ActionButton action={() => api("/api/payments/p1/refund", { method: "POST", body: { amount: 1 } })} confirm={{ title: "Refund payment?", message: "Refund 1.00", danger: true, confirmLabel: "Refund now" }}>
        Refund
      </ActionButton>
    );
    await user.click(screen.getByRole("button", { name: "Refund" }));
    await user.click(await screen.findByRole("button", { name: "Refund now" }));
    await dialog();
    await user.keyboard("{Escape}");
    // The password dialog closed; the confirm dialog stays open showing the cancellation.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm your password" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Refund payment?" })).toHaveTextContent(REAUTH_CANCELLED_MESSAGE);
    expect(performed).toBe(0);
  });

  it("without a provider (no UI), ReauthRequiredError propagates unchanged", async () => {
    const err = await api("/api/payments/p1/refund", { method: "POST", body: {} }).then(unexpected, (e: ApiError) => e);
    expect(err.code).toBe("ReauthRequiredError");
    expect(refundCalls()).toHaveLength(1);
  });
});

describe("desktop bridge (Electron restore)", () => {
  it("the main process's request shows the same dialog and gets the outcome back", async () => {
    const user = userEvent.setup();
    let handler: ((scope: string) => Promise<string>) | undefined;
    const unsubscribe = vi.fn();
    (globalThis as { aharosDesktop?: unknown }).aharosDesktop = { onReauthRequest: (h: typeof handler) => ((handler = h), unsubscribe) };
    const view = renderApp(<span />);
    await waitFor(() => expect(handler).toBeDefined());

    let outcome!: Promise<string>;
    act(() => { outcome = handler!("backup.restore"); });
    expect(await dialog()).toHaveTextContent("Confirm your password to restore a backup.");
    await user.type(screen.getByLabelText("Current password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await outcome).toBe("granted");
    expect(reauthCalls()[0].body).toEqual({ password: PASSWORD, scope: "backup.restore" });

    act(() => { outcome = handler!("backup.restore"); });
    await dialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await outcome).toBe("cancelled");
    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
