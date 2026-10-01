"use client";

import type { CartAction, CartState } from "@/features/pos/cart";
import { POS_ORDER_TYPES } from "@/features/pos/cart";
import { estimateTotals } from "@/features/pos/estimate";
import type { OrderDTO, TableDTO } from "@/features/pos/types";
import { formatMoney, formatQty, toNumber } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";

type Props = {
  state: CartState;
  dispatch: (a: CartAction) => void;
  tables: TableDTO[];
  running: OrderDTO | null;
  onPickTable: () => void;
  onPickCustomer: () => void;
  canUseCustomers: boolean;
};

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "rounded-md bg-vanilla-100 px-2 py-1.5 text-base font-semibold text-ink-900" : "text-sm text-ink-700"}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function CartPanel({ state, dispatch, tables, running, onPickTable, onPickCustomer, canUseCustomers }: Props) {
  const table = tables.find((t) => t.id === state.tableId);
  const estimate = estimateTotals(state.lines);
  const locked = Boolean(running); // order type/table are fixed once the order exists

  return (
    <section aria-label="Current order" className="flex min-h-0 flex-col bg-white">
      <div className="space-y-2 border-b border-ink-200 p-3">
        <div role="radiogroup" aria-label="Order type" className="grid grid-cols-3 gap-1 rounded-md bg-ink-100 p-1">
          {POS_ORDER_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={state.orderType === t.value}
              disabled={locked}
              onClick={() => dispatch({ type: "setOrderType", orderType: t.value })}
              className={`h-9 rounded text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed ${state.orderType === t.value ? "bg-white text-ink-900 shadow-xs" : "text-ink-500 hover:text-ink-800"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {state.orderType === "DINE_IN" && (
            <Button size="sm" onClick={onPickTable} disabled={locked} aria-label={table ? `Table ${table.code}, change table` : "Choose table"}>
              <Icon name="table" /> {table ? `Table ${table.code}` : "Choose table"}
            </Button>
          )}
          {canUseCustomers && (
            <Button size="sm" onClick={onPickCustomer} disabled={locked}>
              <Icon name="user" /> {state.customer ? state.customer.name : "Customer"}
            </Button>
          )}
          {state.orderType === "DINE_IN" && (
            <label className="ml-auto flex items-center gap-1.5 text-sm text-ink-700">
              Covers
              <input type="number" min={1} max={99} value={state.covers} disabled={locked} onChange={(e) => dispatch({ type: "setCovers", covers: Number(e.target.value) })} className="h-8 w-14 rounded border border-ink-300 px-2 text-sm" />
            </label>
          )}
        </div>
        {running && (
          <p className="flex items-center gap-2 text-xs text-ink-500">
            Running order <span className="font-mono">#{running.id.slice(-6).toUpperCase()}</span> <Badge tone="info">{running.status}</Badge>
          </p>
        )}
        {running && running.kots && running.kots.length > 0 && (
          <ul aria-label="Kitchen tickets" className="flex flex-wrap gap-1.5">
            {running.kots.map((k) => (
              <li key={k.id}>
                <Badge tone={k.status === "READY" ? "ok" : k.status === "CANCELLED" ? "bad" : k.status === "SERVED" ? "neutral" : "warn"}>
                  KOT {k.number} · {k.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {running && running.items.length > 0 && (
          <div className="border-b border-ink-200 bg-ink-50 px-3 py-2">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Already ordered</p>
            <ul className="space-y-1">
              {running.items.map((i) => (
                <li key={i.id} className="flex justify-between text-sm text-ink-700">
                  <span>
                    {formatQty(i.qty)} × {i.name}
                    {i.modifiers.length > 0 && <span className="block text-xs text-ink-500">{i.modifiers.map((m) => m.name).join(", ")}</span>}
                  </span>
                  <span className="tabular-nums">{formatMoney(i.lineTotal)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {state.lines.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-500">{running ? "Add items to send another round." : "Tap menu items to start an order."}</p>
        ) : (
          <ul aria-label="New items" className="divide-y divide-ink-100">
            {state.lines.map((l) => {
              const selected = state.selectedKey === l.key;
              return (
                <li key={l.key} className={`px-3 py-2 ${selected ? "bg-brand-50" : ""}`} onClick={() => dispatch({ type: "select", key: l.key })}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-900">{l.name}</p>
                      {l.modifierLabels.length > 0 && <p className="text-xs text-ink-500">{l.modifierLabels.join(", ")}</p>}
                      {l.notes && <p className="text-xs italic text-warn-500">“{l.notes}”</p>}
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMoney(l.qty * (l.unitPrice + l.modifiersPerUnit))}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Button size="sm" onClick={() => dispatch({ type: "dec", key: l.key })} aria-label={`Decrease ${l.name}`}><Icon name="minus" /></Button>
                    <input
                      aria-label={`Quantity of ${l.name}`}
                      inputMode="numeric"
                      value={l.qty}
                      onChange={(e) => dispatch({ type: "setQty", key: l.key, qty: Number(e.target.value) })}
                      className="h-8 w-12 rounded border border-ink-300 text-center text-sm tabular-nums"
                    />
                    <Button size="sm" onClick={() => dispatch({ type: "inc", key: l.key })} aria-label={`Increase ${l.name}`}><Icon name="plus" /></Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Note for ${l.name}`}
                      onClick={() => {
                        const n = window.prompt("Kitchen note for this item", l.notes ?? "");
                        if (n !== null) dispatch({ type: "setLineNote", key: l.key, notes: n });
                      }}
                    >
                      <Icon name="note" />
                    </Button>
                    <Button size="sm" variant="ghost" className="ml-auto text-bad-500" onClick={() => dispatch({ type: "remove", key: l.key })} aria-label={`Remove ${l.name}`}>
                      <Icon name="trash" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-1 border-t border-ink-200 p-3">
        {running ? (
          <>
            <Row label="Subtotal" value={formatMoney(running.subtotal)} />
            {toNumber(running.discount) > 0 && <Row label="Discount" value={`− ${formatMoney(running.discount)}`} />}
            <Row label="Tax" value={formatMoney(running.tax)} />
            <Row label="Total" value={formatMoney(running.total)} strong />
            {state.lines.length > 0 && <p className="pt-1 text-xs text-ink-500">+ new items ≈ {formatMoney(estimate.total)} (priced by the server when sent)</p>}
          </>
        ) : (
          <>
            <Row label="Subtotal" value={formatMoney(estimate.subtotal)} />
            <Row label="Tax" value={formatMoney(estimate.tax)} />
            <Row label="Estimate" value={formatMoney(estimate.total)} strong />
            <p className="text-xs text-ink-500">Final prices are confirmed by the server when the order is placed.</p>
          </>
        )}
      </div>
    </section>
  );
}
