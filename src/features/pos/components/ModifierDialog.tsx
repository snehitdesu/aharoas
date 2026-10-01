"use client";

import { useMemo, useState } from "react";
import type { MenuItemDTO } from "@/features/pos/types";
import type { CartLine } from "@/features/pos/cart";
import { activeGroups, groupRule, summarizeSelection, toggleOption, validateSelection, type Selection } from "@/features/pos/modifiers";
import { formatMoney, toNumber } from "@/lib/format";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

/** Variant + modifier selection for one menu item. Rules come from modifiers.ts (mirrors the server). */
export function ModifierDialog({ item, onClose, onAdd }: { item: MenuItemDTO; onClose: () => void; onAdd: (line: Omit<CartLine, "key">) => void }) {
  const groups = useMemo(() => activeGroups(item), [item]);
  const variants = item.variants.filter((v) => v.active);
  const [variantId, setVariantId] = useState<string | undefined>(undefined);
  const [sel, setSel] = useState<Selection>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");
  const [attempted, setAttempted] = useState(false);

  const { valid, errors } = validateSelection(groups, sel);
  const summary = summarizeSelection(groups, sel);
  const variant = variants.find((v) => v.id === variantId);
  const unitPrice = item.effectivePrice + (variant ? toNumber(variant.priceDelta) : 0);

  function add() {
    setAttempted(true);
    if (!valid) return;
    onAdd({
      menuItemId: item.id,
      name: variant ? `${item.name} (${variant.name})` : item.name,
      variantId,
      variantName: variant?.name,
      modifierOptionIds: summary.ids,
      modifierLabels: summary.labels,
      unitPrice,
      modifiersPerUnit: summary.perUnit,
      taxPct: toNumber(item.taxPct),
      qty,
      notes: notes.trim() || undefined,
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={item.name}
      description={`${formatMoney(item.effectivePrice)} base`}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2" role="group" aria-label="Quantity">
            <Button size="lg" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease quantity"><Icon name="minus" /></Button>
            <span className="w-8 text-center text-base font-semibold tabular-nums" aria-live="polite">{qty}</span>
            <Button size="lg" onClick={() => setQty((q) => Math.min(99, q + 1))} aria-label="Increase quantity"><Icon name="plus" /></Button>
          </div>
          <Button variant="primary" size="lg" onClick={add} data-autofocus>
            Add · {formatMoney(qty * (unitPrice + summary.perUnit))}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {variants.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Size / variant</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[{ id: undefined, name: "Regular", priceDelta: 0 }, ...variants].map((v) => (
                <button
                  key={v.id ?? "base"}
                  type="button"
                  role="radio"
                  aria-checked={variantId === v.id}
                  onClick={() => setVariantId(v.id)}
                  className={`h-12 rounded-md border px-3 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${variantId === v.id ? "border-brand-600 bg-brand-50 font-medium" : "border-ink-300 hover:bg-ink-100"}`}
                >
                  {v.name}
                  {toNumber(v.priceDelta) !== 0 && <span className="block text-xs text-ink-500">{toNumber(v.priceDelta) > 0 ? "+" : ""}{formatMoney(v.priceDelta)}</span>}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {groups.map((g) => {
          const chosen = sel[g.id] ?? [];
          const single = g.maxSelect === 1;
          const error = attempted ? errors[g.id] : undefined;
          return (
            <fieldset key={g.id} aria-describedby={error ? `err-${g.id}` : undefined}>
              <legend className="mb-2 flex w-full items-baseline justify-between text-sm">
                <span className="font-semibold">{g.name}</span>
                <span className={`text-xs ${g.minSelect > 0 ? "text-ink-700" : "text-ink-500"}`}>{groupRule(g)}</span>
              </legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role={single ? "radiogroup" : "group"}>
                {g.options.map((o) => {
                  const on = chosen.includes(o.id);
                  const blocked = !on && !single && chosen.length >= g.maxSelect;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role={single ? "radio" : "checkbox"}
                      aria-checked={on}
                      disabled={blocked}
                      onClick={() => setSel((s) => toggleOption(s, g, o.id))}
                      className={`h-12 rounded-md border px-3 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50 ${on ? "border-brand-600 bg-brand-50 font-medium" : "border-ink-300 hover:bg-ink-100"}`}
                    >
                      {o.name}
                      {toNumber(o.priceDelta) > 0 && <span className="block text-xs text-ink-500">+{formatMoney(o.priceDelta)}</span>}
                    </button>
                  );
                })}
              </div>
              {error && <p id={`err-${g.id}`} role="alert" className="mt-1 text-xs font-medium text-bad-500">{error}</p>}
            </fieldset>
          );
        })}

        <label className="block">
          <span className="text-sm font-semibold">Kitchen note</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 200))} placeholder="e.g. less spicy" className="mt-1 h-10 w-full rounded-md border border-ink-300 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" />
        </label>
      </div>
    </Dialog>
  );
}
