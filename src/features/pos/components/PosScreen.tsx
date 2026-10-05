"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, ApiError, describeError } from "@/lib/api/client";
import { cartBlocker, cartContextFromOrder, cartFingerprint, cartReducer, emptyCart, toOrderItems, type CartLine } from "@/features/pos/cart";
import { needsConfiguration } from "@/features/pos/modifiers";
import { createSubmitGuard } from "@/features/pos/submitGuard";
import type { MenuItemDTO, OrderDTO, TableDTO } from "@/features/pos/types";
import { toNumber } from "@/lib/format";
import { MenuPanel } from "@/features/pos/components/MenuPanel";
import { CartPanel } from "@/features/pos/components/CartPanel";
import { ModifierDialog } from "@/features/pos/components/ModifierDialog";
import { TablePicker } from "@/features/pos/components/TablePicker";
import { CustomerPicker } from "@/features/pos/components/CustomerPicker";
import { PaymentDialog } from "@/features/pos/components/PaymentDialog";
import { OpenOrdersDialog, isIncomingQr, type OpenOrder } from "@/features/pos/components/OpenOrdersDialog";
import { createPoller } from "@/lib/polling";
import { BACKGROUND_HEADER } from "@/constants/auth";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

export type PosPermissions = { pay: boolean; discount: boolean; cancel: boolean; customerView: boolean; customerManage: boolean };

type Action = "save" | "send" | "pay" | "cancel" | "discount" | null;

/** Counter POS. Every mutation goes through /api; the cart is only a draft until the server confirms. */
export function PosScreen({ outletId, perms }: { outletId: string; perms: PosPermissions }) {
  const toast = useToast();
  const [menu, setMenu] = useState<MenuItemDTO[] | null>(null);
  const [tables, setTables] = useState<TableDTO[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [cart, dispatch] = useReducer(cartReducer, emptyCart("DINE_IN"));
  const [running, setRunning] = useState<OrderDTO | null>(null);
  const [configuring, setConfiguring] = useState<MenuItemDTO | null>(null);
  const [dialog, setDialog] = useState<"table" | "customer" | "orders" | "cancel" | "discount" | null>(null);
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action>(null);
  const [reason, setReason] = useState("");
  const [discount, setDiscount] = useState("");
  const guard = useRef(createSubmitGuard());
  const searchRef = useRef<HTMLInputElement>(null);
  const [incoming, setIncoming] = useState(0);

  // Guests' QR orders arrive without anyone at the till: poll for ones awaiting acceptance.
  useEffect(() => {
    const p = createPoller<{ items: OpenOrder[] }>({
      intervalMs: 10_000,
      fetch: (signal) => api<{ items: OpenOrder[] }>("/api/orders", { query: { outletId, active: "true", take: 100 }, signal, headers: { [BACKGROUND_HEADER]: "1" } }),
      onData: (d) => setIncoming(d.items.filter(isIncomingQr).length),
    });
    p.start();
    return () => p.stop();
  }, [outletId]);

  const loadTables = useCallback(async () => {
    try {
      setTables(await api<TableDTO[]>("/api/master/tables", { query: { outletId } }));
    } catch (e) {
      if (!(e instanceof ApiError && e.kind === "forbidden")) toast.show(`Tables: ${describeError(e)}`, "bad");
    }
  }, [outletId, toast]);

  const load = useCallback(async () => {
    setLoadError(null);
    setMenu(null);
    try {
      const [items] = await Promise.all([api<MenuItemDTO[]>("/api/menu", { query: { outletId, activeOnly: "true" } }), loadTables()]);
      setMenu(items);
    } catch (e) {
      setLoadError(e);
    }
  }, [outletId, loadTables]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshRunning = useCallback(async (orderId: string) => {
    const o = await api<OrderDTO>(`/api/orders/${orderId}`);
    setRunning(["PAID", "CANCELLED", "REFUNDED"].includes(o.status) ? null : o);
    return o;
  }, []);

  // Keyboard: "/" focuses search (when not typing); Ctrl/Cmd+Enter sends to kitchen.
  const sendRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select, [role=dialog]");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function addLine(line: Omit<CartLine, "key">) {
    dispatch({ type: "add", line });
    setConfiguring(null);
  }

  function pick(item: MenuItemDTO) {
    if (needsConfiguration(item)) return setConfiguring(item);
    addLine({ menuItemId: item.id, name: item.name, modifierOptionIds: [], modifierLabels: [], unitPrice: item.effectivePrice, modifiersPerUnit: 0, taxPct: toNumber(item.taxPct), qty: 1 });
  }

  async function chooseTable(t: TableDTO) {
    setDialog(null);
    dispatch({ type: "setTable", tableId: t.id });
    if (t.status === "AVAILABLE" || t.status === "RESERVED") return setRunning(null);
    try {
      const { items } = await api<{ items: Array<{ id: string }> }>("/api/orders", { query: { outletId, tableId: t.id, active: "true", take: 1 } });
      if (items[0]) await refreshRunning(items[0].id);
      else setRunning(null);
    } catch (e) {
      toast.show(describeError(e), "bad");
    }
  }

  function restoreCartContext(o: OrderDTO) {
    const ctx = cartContextFromOrder({
      channel: o.channel,
      tableId: o.tableId,
      covers: o.covers,
      customer: o.customer ? { id: o.customer.id, name: o.customer.name, phone: o.customer.phone } : null,
    });
    dispatch({ type: "restoreContext", ...ctx });
  }

  async function openOrder(orderId: string) {
    setDialog(null);
    try {
      const o = await refreshRunning(orderId);
      restoreCartContext(o);
    } catch (e) {
      toast.show(describeError(e), "bad");
    }
  }

  function failure(e: unknown) {
    if (e instanceof ApiError && e.kind === "unauthorized") window.location.href = `/login?next=/pos`;
    toast.show(describeError(e), "bad");
  }

  /** New order: one atomic, idempotent POST (order + lines [+ kitchen]). */
  async function placeNew(submit: boolean, thenPay: boolean, action: Action) {
    const blocker = cartBlocker(cart);
    if (blocker) return toast.show(blocker, "bad");
    setBusy(action);
    const result = await guard.current.run(cartFingerprint(cart, submit ? "send" : "save"), (key) =>
      api<OrderDTO>("/api/orders", {
        method: "POST",
        idempotencyKey: key,
        body: { outletId, channel: cart.orderType, tableId: cart.tableId ?? undefined, customerId: cart.customer?.id, covers: cart.covers, notes: cart.notes || undefined, items: toOrderItems(cart), submit },
      })
    );
    setBusy(null);
    if (result.status === "busy") return;
    if (result.status === "error") return failure(result.error);
    const order = result.value;
    restoreCartContext(order);
    void loadTables();
    toast.show(submit ? `Order #${order.id.slice(-6).toUpperCase()} sent to kitchen` : `Order #${order.id.slice(-6).toUpperCase()} saved`, "ok");
    if (thenPay) setPayingOrderId(order.id);
    try {
      restoreCartContext(await refreshRunning(order.id));
    } catch {
      restoreCartContext(order);
      if (!["PAID", "CANCELLED", "REFUNDED"].includes(order.status)) setRunning(order);
    }
  }

  /** Running order: add the new round, then fire it (or submit if the order was only saved). */
  async function addToRunning(thenPay: boolean, action: Action) {
    if (!running) return;
    if (cart.lines.length === 0) {
      // Nothing new to add. An order still OPEN (saved here, or a guest's QR order
      // awaiting acceptance) goes to the kitchen first: once PAID it can no longer
      // be fired, and the food would never be made.
      if (running.status === "OPEN") {
        setBusy(action);
        const result = await guard.current.run(`accept:${running.id}`, () => api(`/api/orders/${running.id}/submit`, { method: "POST", body: {} }));
        setBusy(null);
        await refreshRunning(running.id).catch(() => undefined);
        if (result.status === "busy") return;
        if (result.status === "error") return failure(result.error);
        toast.show(`Order #${running.id.slice(-6).toUpperCase()} accepted and sent to kitchen`, "ok");
        void loadTables();
      }
      if (thenPay) setPayingOrderId(running.id);
      return;
    }
    setBusy(action);
    // One atomic, keyed round (lines + kitchen ticket): a retry after a lost response
    // replays the original round instead of adding the lines a second time.
    const result = await guard.current.run(cartFingerprint(cart, `round:${running.id}`), (key) =>
      api(`/api/orders/${running.id}/rounds`, { method: "POST", idempotencyKey: key, body: { items: toOrderItems(cart), fire: true } })
    );
    if (result.status === "ok") for (const l of cart.lines) dispatch({ type: "remove", key: l.key }); // the round was confirmed
    setBusy(null);
    await refreshRunning(running.id).catch(() => undefined);
    if (result.status === "busy") return;
    if (result.status === "error") return failure(result.error);
    toast.show("Sent to kitchen", "ok");
    if (thenPay) setPayingOrderId(running.id);
  }

  const send = () => (running ? addToRunning(false, "send") : placeNew(true, false, "send"));
  sendRef.current = () => void (busy ? undefined : send());
  const pay = () => (running ? addToRunning(true, "pay") : placeNew(true, true, "pay"));

  async function cancelRunning() {
    if (!running || reason.trim().length < 3) return;
    setBusy("cancel");
    try {
      await api(`/api/orders/${running.id}/cancel`, { method: "POST", body: { reason: reason.trim() } });
      toast.show("Order cancelled", "ok");
      setRunning(null);
      setDialog(null);
      setReason("");
      dispatch({ type: "clear" });
      void loadTables();
    } catch (e) {
      failure(e);
    } finally {
      setBusy(null);
    }
  }

  async function applyDiscount() {
    if (!running) return;
    setBusy("discount");
    try {
      await api(`/api/orders/${running.id}/discount`, { method: "POST", body: { amount: Number(discount) || 0 } });
      await refreshRunning(running.id);
      setDialog(null);
      toast.show("Discount applied", "ok");
    } catch (e) {
      failure(e);
    } finally {
      setBusy(null);
    }
  }

  if (loadError) return <ErrorState error={loadError} onRetry={load} />;
  if (!menu) return <LoadingState label="Loading menu…" />;

  const tableCode = (id: string | null) => tables.find((t) => t.id === id)?.code ?? null;
  const hasLines = cart.lines.length > 0;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_22rem] lg:grid-cols-[1fr_26rem]">
      <MenuPanel ref={searchRef} items={menu} onPick={pick} />

      <div className="flex min-h-0 flex-col border-l border-ink-200">
        <CartPanel
          state={cart}
          dispatch={dispatch}
          tables={tables}
          running={running}
          onPickTable={() => setDialog("table")}
          onPickCustomer={() => setDialog("customer")}
          canUseCustomers={perms.customerView}
        />
        <div className="grid grid-cols-3 gap-2 border-t border-ink-200 bg-ink-50 p-2" role="toolbar" aria-label="Order actions">
          <Button size="lg" onClick={() => setDialog("orders")} aria-label={incoming ? `Open orders, ${incoming} new QR ${incoming === 1 ? "order" : "orders"}` : "Open orders"}>
            Open orders
            {incoming > 0 && <span aria-hidden className="ml-1.5 rounded-full bg-warn-500 px-2 text-xs font-bold text-white tabular-nums">{incoming}</span>}
          </Button>
          <Button size="lg" onClick={() => (running ? (setRunning(null), dispatch({ type: "clear" })) : dispatch({ type: "clear" }))} disabled={!hasLines && !running}>
            {running ? "Close" : "Clear"}
          </Button>
          {running ? (
            perms.cancel ? <Button size="lg" variant="danger" onClick={() => setDialog("cancel")}>Cancel order</Button> : <span />
          ) : (
            <Button size="lg" onClick={() => placeNew(false, false, "save")} loading={busy === "save"} disabled={!hasLines || busy !== null} title="Save the order without sending it to the kitchen">
              Save
            </Button>
          )}
          {running && perms.discount && (
            <Button size="xl" onClick={() => { setDiscount(String(toNumber(running.discount) || "")); setDialog("discount"); }}>Discount</Button>
          )}
          <Button size="xl" variant="primary" className={running && perms.discount ? "col-span-2" : "col-span-3"} onClick={() => void send()} loading={busy === "send"} disabled={(!hasLines && running?.status !== "OPEN") || busy !== null}>
            Send to kitchen
          </Button>
          {perms.pay && (
            <Button size="xl" variant="success" className="col-span-3" onClick={() => void pay()} loading={busy === "pay"} disabled={(!hasLines && !running) || busy !== null}>
              {running ? "Pay" : "Send & pay"}
            </Button>
          )}
        </div>
      </div>

      {configuring && <ModifierDialog item={configuring} onClose={() => setConfiguring(null)} onAdd={addLine} />}
      {dialog === "table" && <TablePicker tables={tables} selectedId={cart.tableId} onSelect={chooseTable} onClose={() => setDialog(null)} />}
      {dialog === "customer" && (
        <CustomerPicker current={cart.customer} canCreate={perms.customerManage} onSelect={(c) => { dispatch({ type: "setCustomer", customer: c }); setDialog(null); }} onClose={() => setDialog(null)} />
      )}
      {dialog === "orders" && <OpenOrdersDialog outletId={outletId} tableCode={tableCode} onOpen={openOrder} onClose={() => setDialog(null)} />}
      {dialog === "cancel" && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title="Cancel order"
          description="This voids the order. It cannot be undone."
          size="sm"
          footer={<Button variant="danger" onClick={cancelRunning} loading={busy === "cancel"} disabled={reason.trim().length < 3}>Cancel order</Button>}
        >
          <label className="block text-sm">
            Reason (required)
            <input id="cancel-reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus className="mt-1 h-10 w-full rounded-md border border-ink-300 px-3 text-sm" />
          </label>
        </Dialog>
      )}
      {dialog === "discount" && running && (
        <Dialog open onClose={() => setDialog(null)} title="Order discount" size="sm" footer={<Button variant="primary" onClick={applyDiscount} loading={busy === "discount"}>Apply</Button>}>
          <label className="block text-sm">
            Discount amount (₹)
            <input id="discount-amount" name="discount" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ""))} data-autofocus className="mt-1 h-10 w-full rounded-md border border-ink-300 px-3 text-sm" />
          </label>
        </Dialog>
      )}
      {payingOrderId && (
        <PaymentDialog
          orderId={payingOrderId}
          onClose={() => setPayingOrderId(null)}
          onSettled={() => {
            setRunning(null);
            dispatch({ type: "clear" });
            void loadTables();
            toast.show("Payment complete", "ok");
          }}
        />
      )}
    </div>
  );
}
