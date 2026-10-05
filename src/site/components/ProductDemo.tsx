"use client";

import { useMemo, useState } from "react";
import { TabList, useTabs } from "@/site/components/Tabs";

/**
 * "See RESTORA in action": a small simulation of one service, in the browser.
 * It follows the real RESTORA flow (guest order → KOT on the kitchen display →
 * payment → manager's numbers) with the demo menu's prices and 5% tax, but it
 * talks to no server and processes nothing. The UI says so.
 */

type Item = { id: string; name: string; price: number; veg: boolean; station: "Kitchen" | "Bakery" | "Bar" };
const MENU: Item[] = [
  { id: "cb", name: "Chicken Biryani", price: 320, veg: false, station: "Kitchen" },
  { id: "pbm", name: "Paneer Butter Masala", price: 300, veg: true, station: "Kitchen" },
  { id: "dt", name: "Dal Tadka", price: 200, veg: true, station: "Kitchen" },
  { id: "bn", name: "Butter Naan", price: 60, veg: true, station: "Bakery" },
  { id: "mc", name: "Masala Chai", price: 40, veg: true, station: "Bar" },
  { id: "fls", name: "Fresh Lime Soda", price: 80, veg: true, station: "Bar" },
];
const TAX = 0.05;
const TABLES = ["G2", "F4", "G6", "F1"];

type Line = { id: string; qty: number };
type KotStatus = "New" | "Accepted" | "Preparing" | "Ready" | "Served";
type Kot = { no: number; station: Item["station"]; lines: Line[]; status: KotStatus };
type Order = { no: number; table: string; lines: Line[]; kots: Kot[]; paid?: { method: string; total: number } };

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const item = (id: string) => MENU.find((m) => m.id === id)!;
const subtotal = (lines: Line[]) => lines.reduce((s, l) => s + item(l.id).price * l.qty, 0);
const totals = (lines: Line[]) => {
  const sub = subtotal(lines);
  const tax = Math.round(sub * TAX * 100) / 100;
  return { sub, tax, total: sub + tax };
};
const NEXT: Record<KotStatus, { to: KotStatus; label: string } | null> = {
  New: { to: "Accepted", label: "Accept" },
  Accepted: { to: "Preparing", label: "Start" },
  Preparing: { to: "Ready", label: "Ready" },
  Ready: { to: "Served", label: "Served" },
  Served: null,
};

const ROLES = ["Guest", "Kitchen", "Cashier", "Manager"] as const;

export function ProductDemo() {
  const [role, setRole] = useState(0);
  const { tabProps, panelProps } = useTabs(ROLES.length, role, setRole);
  const [cart, setCart] = useState<Line[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [kotNo, setKotNo] = useState(101);
  const [announce, setAnnounce] = useState("");

  const say = (msg: string) => setAnnounce(msg);
  const table = TABLES[orders.length % TABLES.length];

  const add = (id: string, d: number) =>
    setCart((c) => {
      const cur = c.find((l) => l.id === id);
      if (!cur) return d > 0 ? [...c, { id, qty: 1 }] : c;
      const qty = cur.qty + d;
      return qty <= 0 ? c.filter((l) => l.id !== id) : c.map((l) => (l.id === id ? { ...l, qty } : l));
    });

  const place = () => {
    if (!cart.length) return;
    const stations = Array.from(new Set(cart.map((l) => item(l.id).station)));
    const kots = stations.map((st, i) => ({ no: kotNo + i, station: st, lines: cart.filter((l) => item(l.id).station === st), status: "New" as KotStatus }));
    const no = orders.length + 1;
    setOrders((o) => [...o, { no, table, lines: cart, kots }]);
    setKotNo((n) => n + kots.length);
    setCart([]);
    say(`Order ${no} for table ${table} placed. ${kots.length} kitchen ticket${kots.length > 1 ? "s" : ""} created.`);
  };

  const advance = (orderNo: number, kot: number) => {
    setOrders((os) =>
      os.map((o) =>
        o.no !== orderNo
          ? o
          : {
              ...o,
              kots: o.kots.map((k) => {
                if (k.no !== kot) return k;
                const n = NEXT[k.status];
                if (n) say(`KOT ${k.no} is now ${n.to.toLowerCase()}.`);
                return n ? { ...k, status: n.to } : k;
              }),
            },
      ),
    );
  };

  const pay = (orderNo: number, method: string) => {
    setOrders((os) => os.map((o) => (o.no === orderNo ? { ...o, paid: { method, total: totals(o.lines).total } } : o)));
    say(`Order ${orderNo} paid by ${method}. Receipt ready.`);
  };

  const reset = () => {
    setCart([]);
    setOrders([]);
    setKotNo(101);
    setRole(0);
    say("Demonstration reset.");
  };

  const stats = useMemo(() => {
    const paid = orders.filter((o) => o.paid);
    const net = paid.reduce((s, o) => s + totals(o.lines).sub, 0);
    const byMethod: Record<string, number> = {};
    for (const o of paid) byMethod[o.paid!.method] = (byMethod[o.paid!.method] ?? 0) + o.paid!.total;
    const qty: Record<string, number> = {};
    for (const o of orders) for (const l of o.lines) qty[l.id] = (qty[l.id] ?? 0) + l.qty;
    const best = Object.entries(qty).sort((a, b) => b[1] - a[1])[0];
    const open = orders.filter((o) => !o.paid).length;
    const kitchen = orders.flatMap((o) => o.kots).filter((k) => k.status !== "Served");
    return { net, paid: paid.length, open, kitchen: kitchen.length, ready: kitchen.filter((k) => k.status === "Ready").length, byMethod, best: best ? `${item(best[0]).name} (${best[1]})` : "None yet" };
  }, [orders]);

  const kotsInKitchen = orders.flatMap((o) => o.kots.filter((k) => k.status !== "Served").map((k) => ({ ...k, order: o })));
  const ct = totals(cart);

  return (
    <div className="overflow-hidden rounded-[var(--s-radius-lg)] bg-[color:var(--s-surface)] shadow-[0_0_0_1px_rgb(36_24_15/0.1),0_30px_60px_-34px_rgb(36_24_15/0.4)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[color:var(--s-rule)] px-5 py-4 sm:px-7">
        <TabList label="Demo role">
          {ROLES.map((r, i) => (
            <button key={r} {...tabProps(i)}>
              {r}
              {r === "Kitchen" && stats.kitchen > 0 && <span className="ml-1.5 s-num text-[color:var(--s-accent-ink)]">{stats.kitchen}</span>}
              {r === "Cashier" && stats.open > 0 && <span className="ml-1.5 s-num text-[color:var(--s-accent-ink)]">{stats.open}</span>}
            </button>
          ))}
        </TabList>
        <button type="button" onClick={reset} className="s-link text-sm">
          Reset demo
        </button>
      </div>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      <div className="min-h-[30rem] px-5 py-7 sm:px-7">
        {/* Guest */}
        <div {...panelProps(0)} className="outline-none">
          {role === 0 && (
            <div className="s-fade-swap grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div>
                <p className="s-small">Scanned the QR code on table {table} · Demo Restaurant</p>
                <h3 className="s-h4 mt-1 text-xl">Menu</h3>
                <ul className="mt-4 divide-y divide-[color:var(--s-rule)] border-y border-[color:var(--s-rule)]">
                  {MENU.map((m) => {
                    const q = cart.find((l) => l.id === m.id)?.qty ?? 0;
                    return (
                      <li key={m.id} className="flex items-center gap-3 py-3">
                        <span aria-hidden className={`grid h-4 w-4 flex-none place-items-center rounded-[3px] border-[1.5px] ${m.veg ? "border-[#3d6a2f]" : "border-[#a52a1f]"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${m.veg ? "bg-[#3d6a2f]" : "bg-[#a52a1f]"}`} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-[color:var(--s-ink)]">
                            {m.name} <span className="sr-only">{m.veg ? "(vegetarian)" : "(non-vegetarian)"}</span>
                          </p>
                          <p className="s-small s-num">{money(m.price)}</p>
                        </div>
                        {q === 0 ? (
                          <button type="button" className="s-btn s-btn-ghost s-btn-sm" onClick={() => add(m.id, 1)} aria-label={`Add ${m.name}`}>
                            Add
                          </button>
                        ) : (
                          <div className="flex items-center gap-1" role="group" aria-label={`${m.name} quantity`}>
                            <button type="button" className="s-btn s-btn-ghost s-btn-sm w-10 !px-0" onClick={() => add(m.id, -1)} aria-label={`Remove one ${m.name}`}>
                              −
                            </button>
                            <span className="w-7 text-center font-semibold s-num" aria-live="polite">
                              {q}
                            </span>
                            <button type="button" className="s-btn s-btn-ghost s-btn-sm w-10 !px-0" onClick={() => add(m.id, 1)} aria-label={`Add one more ${m.name}`}>
                              +
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="lg:pt-12">
                <div className="rounded-[var(--s-radius)] bg-[color:var(--s-sunken)] p-5">
                  <h3 className="s-h4">Your cart</h3>
                  {cart.length === 0 ? (
                    <p className="s-small mt-3">Add a few dishes to start an order.</p>
                  ) : (
                    <>
                      <ul className="mt-3 grid gap-1.5 text-[0.9375rem]">
                        {cart.map((l) => (
                          <li key={l.id} className="flex justify-between gap-3">
                            <span>
                              {l.qty} × {item(l.id).name}
                            </span>
                            <span className="s-num">{money(item(l.id).price * l.qty)}</span>
                          </li>
                        ))}
                      </ul>
                      <dl className="mt-4 grid gap-1 border-t border-[color:var(--s-rule-strong)] pt-3 text-[0.9375rem]">
                        <div className="flex justify-between"><dt>Tax (5%)</dt><dd className="s-num">{money(ct.tax)}</dd></div>
                        <div className="flex justify-between font-semibold text-[color:var(--s-ink)]"><dt>Total</dt><dd className="s-num">{money(ct.total)}</dd></div>
                      </dl>
                    </>
                  )}
                  <button type="button" className="s-btn s-btn-primary mt-5 w-full" onClick={place} disabled={!cart.length} aria-disabled={!cart.length}>
                    Place order
                  </button>
                </div>
                {orders.length > 0 && (
                  <p className="s-small mt-4">
                    {orders.length} order{orders.length > 1 ? "s" : ""} placed.{" "}
                    <button type="button" className="s-link" onClick={() => setRole(1)}>
                      See the kitchen <span aria-hidden>→</span>
                    </button>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Kitchen */}
        <div {...panelProps(1)} className="outline-none">
          {role === 1 && (
            <div className="s-fade-swap">
              <p className="s-small">Kitchen display · all stations · one ticket per station</p>
              {kotsInKitchen.length === 0 ? (
                <Empty text="No tickets. Place an order as the guest first." action="Order as the guest" onAction={() => setRole(0)} />
              ) : (
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  {([["New", ["New"]], ["In progress", ["Accepted", "Preparing"]], ["Ready", ["Ready"]]] as [string, KotStatus[]][]).map(([col, states]) => (
                    <section key={col} aria-label={col} className="rounded-[var(--s-radius)] bg-[color:var(--s-sunken)] p-3">
                      <h3 className="flex items-center justify-between px-1 text-sm font-bold uppercase tracking-[0.08em] text-[color:var(--s-ink)]">
                        {col} <span className="s-num">{kotsInKitchen.filter((k) => states.includes(k.status)).length}</span>
                      </h3>
                      <ul className="mt-3 grid gap-3">
                        {kotsInKitchen
                          .filter((k) => states.includes(k.status))
                          .map((k) => {
                            const n = NEXT[k.status]!;
                            return (
                              <li key={k.no} className="rounded-xl bg-[color:var(--s-surface)] p-4 shadow-[0_0_0_1px_rgb(36_24_15/0.08)]">
                                <p className="flex items-baseline justify-between gap-2 font-semibold text-[color:var(--s-ink)]">
                                  KOT {k.no} <span className="text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--s-muted)]">{k.status}</span>
                                </p>
                                <p className="s-small">
                                  Table {k.order.table} · {k.station}
                                </p>
                                <ul className="mt-2 text-[0.9375rem]">
                                  {k.lines.map((l) => (
                                    <li key={l.id}>
                                      {l.qty} × {item(l.id).name}
                                    </li>
                                  ))}
                                </ul>
                                <button type="button" className={`s-btn s-btn-sm mt-3 w-full ${k.status === "Preparing" ? "s-btn-dark" : "s-btn-primary"}`} onClick={() => advance(k.order.no, k.no)}>
                                  {n.label} <span className="sr-only">KOT {k.no}</span>
                                </button>
                              </li>
                            );
                          })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Cashier */}
        <div {...panelProps(2)} className="outline-none">
          {role === 2 && (
            <div className="s-fade-swap">
              <p className="s-small">POS · bills</p>
              {orders.length === 0 ? (
                <Empty text="No orders yet. Place one as the guest." action="Order as the guest" onAction={() => setRole(0)} />
              ) : (
                <ul className="mt-5 grid gap-4 md:grid-cols-2">
                  {orders.map((o) => {
                    const t = totals(o.lines);
                    return (
                      <li key={o.no} className="rounded-[var(--s-radius)] border border-[color:var(--s-rule)] p-5">
                        <div className="flex items-baseline justify-between">
                          <h3 className="s-h4">
                            Order {o.no} · Table {o.table}
                          </h3>
                          <span className="s-small">{o.paid ? "Paid" : "Open"}</span>
                        </div>
                        <ul className="mt-3 grid gap-1 text-[0.9375rem]">
                          {o.lines.map((l) => (
                            <li key={l.id} className="flex justify-between gap-3">
                              <span>
                                {l.qty} × {item(l.id).name}
                              </span>
                              <span className="s-num">{money(item(l.id).price * l.qty)}</span>
                            </li>
                          ))}
                        </ul>
                        <dl className="mt-3 grid gap-1 border-t border-[color:var(--s-rule)] pt-3 text-[0.9375rem]">
                          <div className="flex justify-between"><dt>Subtotal</dt><dd className="s-num">{money(t.sub)}</dd></div>
                          <div className="flex justify-between"><dt>Tax (5%)</dt><dd className="s-num">{money(t.tax)}</dd></div>
                          <div className="flex justify-between font-semibold text-[color:var(--s-ink)]"><dt>Total</dt><dd className="s-num">{money(t.total)}</dd></div>
                        </dl>
                        {o.paid ? (
                          <p className="mt-4 rounded-lg bg-[#eef3e8] px-3 py-2 text-[0.9375rem] text-[#30552a]">
                            Receipt: {money(o.paid.total)} paid by {o.paid.method}.
                          </p>
                        ) : (
                          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={`Take payment for order ${o.no}`}>
                            {["Cash", "UPI", "Card"].map((m) => (
                              <button key={m} type="button" className="s-btn s-btn-ghost s-btn-sm" onClick={() => pay(o.no, m)}>
                                {m}
                              </button>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Manager */}
        <div {...panelProps(3)} className="outline-none">
          {role === 3 && (
            <div className="s-fade-swap">
              <p className="s-small">Manager · this demonstration&apos;s day so far</p>
              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
                {[
                  ["Net sales (ex tax)", money(stats.net)],
                  ["Paid orders", String(stats.paid)],
                  ["Open orders", String(stats.open)],
                  ["Tickets in kitchen", `${stats.kitchen}${stats.ready ? ` (${stats.ready} ready)` : ""}`],
                ].map(([k, v]) => (
                  <div key={k} className="border-t border-[color:var(--s-rule-strong)] pt-4">
                    <dt className="s-small">{k}</dt>
                    <dd className="mt-1 font-display text-3xl font-semibold text-[color:var(--s-ink)] s-num">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-10 grid gap-8 md:grid-cols-2">
                <div>
                  <h3 className="s-h4">Payments by method</h3>
                  {Object.keys(stats.byMethod).length === 0 ? (
                    <p className="s-small mt-2">No payments yet. Take one as the cashier.</p>
                  ) : (
                    <ul className="mt-2 grid gap-1">
                      {Object.entries(stats.byMethod).map(([m, v]) => (
                        <li key={m} className="flex justify-between">
                          <span>{m}</span>
                          <span className="s-num">{money(v)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="s-h4">Best seller</h3>
                  <p className="mt-2">{stats.best}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="border-t border-[color:var(--s-rule)] bg-[color:var(--s-sunken)] px-5 py-3 text-sm sm:px-7">
        <strong className="font-semibold text-[color:var(--s-ink)]">Interactive demonstration.</strong> It runs in your browser with sample menu data. No real orders, transactions or payments are processed.
      </p>
    </div>
  );
}

function Empty({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <div className="mt-8 grid place-items-center rounded-[var(--s-radius)] border border-dashed border-[color:var(--s-rule-strong)] px-6 py-16 text-center">
      <p>{text}</p>
      <button type="button" className="s-btn s-btn-dark s-btn-sm mt-4" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}
