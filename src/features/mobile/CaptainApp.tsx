"use client";

/**
 * Captain / waiter app (phone-first). Tables → table → add items (menu,
 * variants, modifiers, notes) → send to kitchen → follow the KOTs → mark READY
 * food served → request the bill → see payment status → completed.
 *
 * Every price comes from the server (the draft shows the menu price only as an
 * estimate). Each send is ONE request with a stable Idempotency-Key, kept until
 * the server confirms: a double tap, a lost response or a retry after a dead
 * network replays the original order / round instead of creating a second one.
 * Board and order refresh by polling (15 s / 10 s); there is no offline queue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, describeError } from "@/lib/api/client";
import { createPoller } from "@/lib/polling";
import { BACKGROUND_HEADER } from "@/constants/auth";
import { formatMoney, toNumber } from "@/lib/format";
import { createSubmitGuard } from "@/features/pos/submitGuard";
import { newIdempotencyKey } from "@/lib/idempotency";
import { needsConfiguration } from "@/features/pos/modifiers";
import { ModifierDialog } from "@/features/pos/components/ModifierDialog";
import type { CartLine } from "@/features/pos/cart";
import type { MenuItemDTO, OrderDTO } from "@/features/pos/types";
import type { BoardTable, TableFilter } from "@/server/services/mobile";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { AlertCenter, MobileShell, useOnline, useUnread } from "@/features/mobile/MobileShell";

export type CaptainPerms = { create: boolean; modify: boolean; serve: boolean };
type Board = { tables: BoardTable[]; counts: Record<TableFilter, number> };
type FullOrder = OrderDTO & { kots?: Array<{ id: string; number: number; status: string; items?: Array<{ orderItemId: string; status: string }> }> };
type Draft = CartLine;

const FILTERS: Array<{ value: TableFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "available", label: "Free" },
  { value: "occupied", label: "Occupied" },
  { value: "kitchen", label: "In kitchen" },
  { value: "ready", label: "Food ready" },
  { value: "payment", label: "Payment" },
];
const KOT_TONE: Record<string, "neutral" | "info" | "warn" | "ok" | "bad"> = { NEW: "info", ACCEPTED: "info", PREPARING: "warn", READY: "ok", SERVED: "neutral", CANCELLED: "bad" };
const KOT_LABEL: Record<string, string> = { NEW: "Sent", ACCEPTED: "Accepted", PREPARING: "Cooking", READY: "Ready", SERVED: "Served", CANCELLED: "Cancelled" };

function tableTone(t: BoardTable): string {
  if (!t.order) return t.status === "AVAILABLE" ? "border-ok-200 bg-paper" : "border-ink-300 bg-ink-50";
  if (t.tags.includes("ready")) return "border-ok-500 bg-ok-50";
  if (t.tags.includes("payment")) return "border-warn-500 bg-warn-50";
  return "border-brand-300 bg-brand-50";
}

export function CaptainApp({ outletId, outletName, perms, timeZone }: { outletId: string; outletName: string; perms: CaptainPerms; timeZone?: string }) {
  const online = useOnline();
  const unread = useUnread();
  const [tab, setTab] = useState<"tables" | "table" | "alerts">("tables");
  const [board, setBoard] = useState<Board | null>(null);
  const [boardError, setBoardError] = useState<unknown>(null);
  const [filter, setFilter] = useState<TableFilter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const poller = useRef<ReturnType<typeof createPoller> | null>(null);

  useEffect(() => {
    const p = createPoller<Board>({
      intervalMs: 15_000,
      fetch: (signal) => api<Board>("/api/mobile/tables", { query: { outletId }, signal, headers: { [BACKGROUND_HEADER]: "1" } }),
      onData: (d) => {
        setBoard(d);
        setBoardError(null);
      },
      onError: setBoardError,
    });
    poller.current = p;
    p.start();
    return () => p.stop();
  }, [outletId]);

  const table = board?.tables.find((t) => t.id === selected) ?? null;
  const open = (id: string) => {
    setSelected(id);
    setTab("table");
  };
  const refreshBoard = () => void poller.current?.refresh();

  return (
    <MobileShell
      title={tab === "table" && table ? `Table ${table.code}` : "Captain"}
      subtitle={outletName}
      online={online}
      tab={tab}
      onTab={(t) => (t === "table" && !selected ? setTab("tables") : setTab(t))}
      tabs={[
        { value: "tables", label: "Tables", icon: "table" },
        { value: "table", label: table ? `Table ${table.code}` : "Order", icon: "note" },
        { value: "alerts", label: "Alerts", icon: "bell", badge: unread },
      ]}
    >
      {tab === "tables" && (
        <section aria-label="Tables">
          <div role="group" aria-label="Filter tables" className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" onClick={() => setFilter(f.value)} aria-pressed={filter === f.value}
                className={`shrink-0 rounded-full border px-3.5 py-2 text-sm font-medium ${filter === f.value ? "border-brand-600 bg-brand-600 text-white" : "border-ink-300 bg-paper text-ink-700"}`}>
                {f.label}{board ? ` · ${board.counts[f.value]}` : ""}
              </button>
            ))}
          </div>
          {boardError && !board ? <ErrorState error={boardError} onRetry={refreshBoard} /> : !board ? <LoadingState label="Loading tables…" /> : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {board.tables.filter((t) => filter === "all" || t.tags.includes(filter as Exclude<TableFilter, "all">)).map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => open(t.id)} aria-label={`Table ${t.code}`} data-testid={`table-${t.code}`}
                    className={`flex min-h-[7.5rem] w-full flex-col items-start gap-1 rounded-xl border-2 p-3 text-left shadow-card ${tableTone(t)}`}>
                    <span className="flex w-full items-center justify-between">
                      <span className="text-lg font-semibold text-ink-900">{t.code}</span>
                      <span className="text-xs text-ink-500">{t.capacity} seats</span>
                    </span>
                    {t.order ? (
                      <>
                        <span className="text-base font-semibold tabular-nums">{formatMoney(t.order.total)}</span>
                        <span className="text-xs text-ink-600">{t.order.elapsedMinutes} min{t.order.openedBy ? ` · ${t.order.openedBy}` : ""}</span>
                        <span className="flex flex-wrap gap-1">
                          {t.order.unsent > 0 && <Badge tone="warn">{t.order.unsent} not sent</Badge>}
                          {t.order.kots.live > 0 && <Badge tone="info">Kitchen {t.order.kots.live}</Badge>}
                          {t.order.kots.ready > 0 && <Badge tone="ok">Ready {t.order.kots.ready}</Badge>}
                          {t.order.status === "BILLED" && <Badge tone="warn">Bill</Badge>}
                          {t.order.payment === "PARTIAL" && <Badge tone="warn">Part paid</Badge>}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-ink-600">{t.status === "AVAILABLE" ? "Free" : t.status.replace(/_/g, " ").toLowerCase()}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {tab === "table" && (table ? <TablePanel key={table.id} outletId={outletId} table={table} perms={perms} online={online} onChanged={refreshBoard} onBack={() => setTab("tables")} /> : <EmptyState title="Pick a table" hint="Open a table from the Tables tab." icon="table" />)}
      {tab === "alerts" && <AlertCenter timeZone={timeZone} />}
    </MobileShell>
  );
}

function TablePanel({ outletId, table, perms, online, onChanged, onBack }: { outletId: string; table: BoardTable; perms: CaptainPerms; online: boolean; onChanged: () => void; onBack: () => void }) {
  const toast = useToast();
  const [order, setOrder] = useState<FullOrder | null>(null);
  const [orderId, setOrderId] = useState<string | null>(table.order?.id ?? null);
  const [loading, setLoading] = useState(Boolean(table.order));
  const [menu, setMenu] = useState<MenuItemDTO[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [configuring, setConfiguring] = useState<MenuItemDTO | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [covers, setCovers] = useState(2);
  const [noting, setNoting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const guard = useRef(createSubmitGuard(() => newIdempotencyKey("cap")));

  const loadOrder = useCallback(async (id: string, quiet = false) => {
    try {
      const o = await api<FullOrder>(`/api/orders/${id}`, quiet ? { headers: { [BACKGROUND_HEADER]: "1" } } : {});
      setOrder(o);
    } catch (e) {
      if (!quiet) toast.show(describeError(e), "bad");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!orderId) return;
    void loadOrder(orderId);
    const p = createPoller<FullOrder>({ intervalMs: 10_000, fetch: (signal) => api<FullOrder>(`/api/orders/${orderId}`, { signal, headers: { [BACKGROUND_HEADER]: "1" } }), onData: setOrder });
    p.start();
    return () => p.stop();
  }, [orderId, loadOrder]);

  useEffect(() => {
    if (!picking || menu) return;
    api<MenuItemDTO[]>("/api/menu", { query: { outletId, activeOnly: "true" } }).then(setMenu).catch((e) => toast.show(describeError(e), "bad"));
  }, [picking, menu, outletId, toast]);

  const addDraft = (line: Omit<Draft, "key">) => {
    setDraft((d) => [...d, { ...line, key: `${line.menuItemId}-${Date.now()}-${d.length}` }]);
    setConfiguring(null);
    toast.show(`${line.qty} × ${line.name} added`, "ok");
  };
  const pick = (item: MenuItemDTO) => {
    if (needsConfiguration(item)) return setConfiguring(item);
    addDraft({ menuItemId: item.id, name: item.name, modifierOptionIds: [], modifierLabels: [], unitPrice: item.effectivePrice, modifiersPerUnit: 0, taxPct: toNumber(item.taxPct), qty: 1 });
  };

  const closed = order ? ["PAID", "CANCELLED", "REFUNDED"].includes(order.status) : false;
  const canAdd = perms.modify && (!order || ["OPEN", "SENT", "PREPARING"].includes(order.status));
  const lines = draft.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, modifierOptionIds: l.modifierOptionIds.length ? l.modifierOptionIds : undefined, qty: l.qty, notes: l.notes }));

  async function send() {
    if (!draft.length || busy) return;
    if (!online) return toast.show("Offline — the order was not sent. Try again when the connection is back.", "bad");
    setBusy("send");
    const fp = JSON.stringify([orderId, covers, lines]);
    const result = await guard.current.run(fp, (key) =>
      orderId
        ? api<{ order: FullOrder; round: { replayed: boolean } }>(`/api/orders/${orderId}/rounds`, { method: "POST", idempotencyKey: key, body: { items: lines, fire: true } }).then((r) => r.order)
        : api<FullOrder>("/api/orders", { method: "POST", idempotencyKey: key, body: { outletId, channel: "DINE_IN", tableId: table.id, covers, items: lines, submit: true } })
    );
    setBusy(null);
    if (result.status === "busy") return;
    if (result.status === "error") {
      const e = result.error;
      return toast.show(e instanceof ApiError && e.kind === "network" ? "No connection — nothing was lost. Tap Send again; it will not be sent twice." : describeError(e), "bad");
    }
    setDraft([]);
    setOrderId(result.value.id);
    await loadOrder(result.value.id, true);
    toast.show("Sent to kitchen", "ok");
    onChanged();
  }

  async function act(label: string, fn: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
      toast.show(done, "ok");
      if (orderId) await loadOrder(orderId, true);
      onChanged();
    } catch (e) {
      toast.show(describeError(e), "bad");
    } finally {
      setBusy(null);
    }
  }

  const kotOfItem = useMemo(() => {
    const m = new Map<string, { number: number; status: string }>();
    for (const k of order?.kots ?? []) for (const it of k.items ?? []) m.set(it.orderItemId, { number: k.number, status: k.status });
    return m;
  }, [order]);
  const unsent = order?.items.filter((i) => !kotOfItem.has(i.id)) ?? [];
  const paid = (order?.payments ?? []).filter((p) => p.status === "SUCCESS" || p.status === "PARTIAL").reduce((a, p) => a + toNumber(p.amount) - (p.refunds ?? []).reduce((r, x) => r + toNumber(x.amount), 0), 0);
  const total = order ? toNumber(order.total) : 0;
  const draftEstimate = draft.reduce((a, l) => a + l.qty * (l.unitPrice + l.modifiersPerUnit), 0);

  if (loading) return <LoadingState label="Loading order…" />;
  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700"><Icon name="chevronLeft" /> All tables</button>

      {order && (
        <section aria-label="Order status" className="rounded-xl border border-ink-200 bg-paper p-3 shadow-card">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Order #{order.id.slice(-6).toUpperCase()}</p>
            <Badge tone={order.status === "PAID" ? "ok" : order.status === "BILLED" ? "warn" : "info"} >{order.status === "BILLED" ? "Bill requested" : order.status === "PAID" ? "Completed" : order.status.toLowerCase()}</Badge>
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-sm">
            <div><dt className="text-xs text-ink-500">Total</dt><dd className="font-semibold tabular-nums">{formatMoney(total)}</dd></div>
            <div><dt className="text-xs text-ink-500">Paid</dt><dd className="font-semibold tabular-nums">{formatMoney(paid)}</dd></div>
            <div><dt className="text-xs text-ink-500">Due</dt><dd className={`font-semibold tabular-nums ${total - paid > 0.004 ? "text-bad-600" : ""}`}>{formatMoney(Math.max(0, total - paid))}</dd></div>
          </dl>
          {closed && <p className="mt-2 text-sm text-ok-700" data-testid="order-complete">{order.status === "PAID" ? "Paid in full — order complete." : `Order ${order.status.toLowerCase()}.`}</p>}
        </section>
      )}

      {order && order.items.length > 0 && (
        <section aria-label="Items on the order" className="rounded-xl border border-ink-200 bg-paper shadow-card">
          <ul className="divide-y divide-ink-100">
            {order.items.map((i) => {
              const k = kotOfItem.get(i.id);
              return (
                <li key={i.id} className="flex items-start gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{toNumber(i.qty)} × {i.name}</p>
                    {i.modifiers.length > 0 && <p className="text-xs text-ink-500">{i.modifiers.map((m) => m.name).join(", ")}</p>}
                    {i.notes && <p className="text-xs italic text-ink-500">“{i.notes}”</p>}
                  </div>
                  <span className="text-sm tabular-nums">{formatMoney(i.lineTotal)}</span>
                  {k ? (
                    <Badge tone={KOT_TONE[k.status] ?? "neutral"}>{KOT_LABEL[k.status] ?? k.status}</Badge>
                  ) : perms.modify && !closed ? (
                    <Button size="sm" variant="ghost" aria-label={`Remove ${i.name}`} loading={busy === `rm-${i.id}`} onClick={() => act(`rm-${i.id}`, () => api(`/api/orders/items/${i.id}`, { method: "DELETE" }), `${i.name} removed`)}><Icon name="trash" /></Button>
                  ) : <Badge tone="warn">Not sent</Badge>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {order && (order.kots?.length ?? 0) > 0 && (
        <section aria-label="Kitchen tickets" className="rounded-xl border border-ink-200 bg-paper p-3 shadow-card">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">Kitchen</p>
          <ul className="space-y-2">
            {order.kots!.map((k) => (
              <li key={k.id} className="flex items-center gap-2">
                <span className="text-sm font-medium">KOT {k.number}</span>
                <Badge tone={KOT_TONE[k.status] ?? "neutral"}>{KOT_LABEL[k.status] ?? k.status}</Badge>
                {k.status === "READY" && perms.serve && (
                  <Button size="sm" variant="primary" className="ml-auto" loading={busy === `serve-${k.id}`} onClick={() => act(`serve-${k.id}`, () => api(`/api/kitchen/kots/${k.id}/status`, { method: "POST", body: { status: "SERVED" } }), `KOT ${k.number} served`)}>Mark served</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canAdd && !closed && (
        <section aria-label="New items" className="rounded-xl border border-dashed border-brand-300 bg-paper p-3">
          {!orderId && (
            <div className="mb-3 flex items-center gap-3" role="group" aria-label="Guests">
              <span className="text-sm">Guests</span>
              <Button size="lg" aria-label="Fewer guests" onClick={() => setCovers((c) => Math.max(1, c - 1))}><Icon name="minus" /></Button>
              <span className="w-6 text-center font-semibold tabular-nums">{covers}</span>
              <Button size="lg" aria-label="More guests" onClick={() => setCovers((c) => Math.min(50, c + 1))}><Icon name="plus" /></Button>
            </div>
          )}
          {draft.length > 0 && (
            <ul className="mb-3 divide-y divide-ink-100" aria-label="Not yet sent">
              {draft.map((l) => (
                <li key={l.key} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{l.qty} × {l.name}</p>
                    {(l.modifierLabels.length > 0 || l.notes) && <p className="text-xs text-ink-500">{[...l.modifierLabels, l.notes ? `“${l.notes}”` : ""].filter(Boolean).join(" · ")}</p>}
                  </div>
                  <Button size="sm" variant="ghost" aria-label={`Note for ${l.name}`} aria-pressed={noting === l.key} onClick={() => setNoting((k) => (k === l.key ? null : l.key))}><Icon name="note" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${l.name} from the draft`} onClick={() => setDraft((d) => d.filter((x) => x.key !== l.key))}><Icon name="x" /></Button>
                  {noting === l.key && (
                    <input autoFocus maxLength={500} value={l.notes ?? ""} placeholder="e.g. less spicy" aria-label={`Kitchen note for ${l.name}`}
                      onChange={(e) => setDraft((d) => d.map((x) => (x.key === l.key ? { ...x, notes: e.target.value || undefined } : x)))}
                      className="basis-full h-10 rounded-md border border-ink-300 px-3 text-sm" />
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button size="lg" className="flex-1" onClick={() => setPicking(true)}><Icon name="plus" /> Add items</Button>
            <Button size="lg" variant="primary" className="flex-1" disabled={!draft.length} loading={busy === "send"} onClick={send}>
              Send{draft.length ? ` · ~${formatMoney(draftEstimate)}` : ""}
            </Button>
          </div>
          {draft.length > 0 && <p className="mt-2 text-xs text-ink-500">Prices are confirmed by the server when sent (tax added on the bill).</p>}
        </section>
      )}

      {order && !closed && perms.modify && (
        <div className="sticky bottom-20 z-10 flex gap-2">
          {order.status === "BILLED" ? (
            <Link href={`/pos/bill/${order.id}`} className="inline-flex h-12 flex-1 items-center justify-center rounded-md border border-ink-300 bg-paper text-sm font-medium">View bill</Link>
          ) : (
            <Button size="lg" className="flex-1" disabled={unsent.length > 0 || draft.length > 0 || order.status === "OPEN"} loading={busy === "bill"}
              onClick={() => act("bill", () => api(`/api/orders/${order.id}/request-bill`, { method: "POST", body: {} }), "Bill requested — the cashier has been notified")}>
              <Icon name="receipt" /> Request bill
            </Button>
          )}
        </div>
      )}

      {picking && menu === null && <Dialog open onClose={() => setPicking(false)} title="Menu"><LoadingState label="Loading menu…" /></Dialog>}
      {picking && menu && <MenuSheet menu={menu} onPick={pick} onClose={() => setPicking(false)} count={draft.length} />}
      {configuring && <ModifierDialog item={configuring} onClose={() => setConfiguring(null)} onAdd={addDraft} />}
    </div>
  );
}

/** Full-height menu picker: search + category chips + large rows. */
function MenuSheet({ menu, onPick, onClose, count }: { menu: MenuItemDTO[]; onPick: (m: MenuItemDTO) => void; onClose: () => void; count: number }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("");
  const cats = useMemo(() => [...new Map(menu.filter((m) => m.category).map((m) => [m.category!.id, m.category!])).values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [menu]);
  const shown = menu.filter((m) => m.offered !== false && (!cat || m.categoryId === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <Dialog open onClose={onClose} title="Add items" description={count ? `${count} item(s) in the draft` : "Tap an item to add it"} footer={<Button size="lg" variant="primary" onClick={onClose}>Done</Button>}>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search menu" aria-label="Search menu" className="mb-2 h-11 w-full rounded-md border border-ink-300 px-3 text-base" />
      <div className="-mx-1 mb-2 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Categories">
        <button type="button" onClick={() => setCat("")} aria-pressed={!cat} className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${!cat ? "border-brand-600 bg-brand-600 text-white" : "border-ink-300"}`}>All</button>
        {cats.map((c) => <button key={c.id} type="button" onClick={() => setCat(c.id)} aria-pressed={cat === c.id} className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${cat === c.id ? "border-brand-600 bg-brand-600 text-white" : "border-ink-300"}`}>{c.name}</button>)}
      </div>
      <ul className="max-h-[55vh] divide-y divide-ink-100 overflow-y-auto" aria-label="Menu items">
        {shown.map((m) => (
          <li key={m.id}>
            <button type="button" disabled={m.effectiveSoldOut} onClick={() => onPick(m)} className="flex min-h-[3.25rem] w-full items-center gap-2 py-2 text-left disabled:opacity-50">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{m.name}</span>
                {(m.variants.some((v) => v.active) || m.modifierGroups.length > 0) && <span className="block text-xs text-ink-500">Options</span>}
              </span>
              <span className="text-sm tabular-nums">{m.effectiveSoldOut ? "Sold out" : formatMoney(m.effectivePrice)}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="py-6 text-center text-sm text-ink-500">No items match</li>}
      </ul>
    </Dialog>
  );
}
