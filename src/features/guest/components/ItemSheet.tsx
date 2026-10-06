"use client";

import { useMemo, useState } from "react";
import type { CartLine } from "@/features/pos/cart";
import type { MenuItemDTO } from "@/features/pos/types";
import { activeGroups, groupRule, summarizeSelection, toggleOption, validateSelection, type Selection } from "@/features/pos/modifiers";
import { formatMoney, toNumber } from "@/lib/format";
import { GUEST_MAX_LINES, GUEST_MAX_QTY, useStorefront } from "@/features/guest/storefront";
import { Sheet } from "@/features/guest/components/Sheet";
import { ItemThumb, Stepper, VegMark } from "@/features/guest/components/Bits";
import { SfIcon } from "@/features/guest/components/SfIcon";

/** Selection rebuilt from a cart line's option ids (editing an item already in the cart). */
function selectionFromLine(item: MenuItemDTO, line?: CartLine): Selection {
  if (!line) return {};
  const sel: Selection = {};
  for (const g of activeGroups(item)) {
    const ids = g.options.filter((o) => line.modifierOptionIds.includes(o.id)).map((o) => o.id);
    if (ids.length) sel[g.id] = ids;
  }
  return sel;
}

/**
 * Item detail: size (the item's real RESTORA variants), add-ons (its modifier
 * groups with their min / max rules), quantity, kitchen note. The rules mirror
 * the server (menu.priceMenuSelection), which re-checks and prices everything.
 */
export function ItemSheet() {
  const { sheet, closeSheet, dispatch, cart, showToast, data } = useStorefront();
  if (!sheet) return null;
  return <ItemSheetBody key={`${sheet.item.id}:${sheet.editing?.key ?? "new"}`} item={sheet.item} editing={sheet.editing} close={closeSheet} dispatch={dispatch} lineCount={cart.lines.length} toast={showToast} orderingOpen={data.ordering?.open !== false} />;
}

function ItemSheetBody({
  item,
  editing,
  close,
  dispatch,
  lineCount,
  toast,
  orderingOpen,
}: {
  item: MenuItemDTO;
  editing?: CartLine;
  close: () => void;
  dispatch: ReturnType<typeof useStorefront>["dispatch"];
  lineCount: number;
  toast: (m: string) => void;
  orderingOpen: boolean;
}) {
  const groups = useMemo(() => activeGroups(item), [item]);
  const variants = item.variants.filter((v) => v.active);
  const [variantId, setVariantId] = useState<string | undefined>(editing?.variantId);
  const [sel, setSel] = useState<Selection>(() => selectionFromLine(item, editing));
  const [qty, setQty] = useState(editing?.qty ?? 1);
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [attempted, setAttempted] = useState(false);

  const { valid, errors } = validateSelection(groups, sel);
  const summary = summarizeSelection(groups, sel);
  const variant = variants.find((v) => v.id === variantId);
  const unitPrice = item.effectivePrice + (variant ? toNumber(variant.priceDelta) : 0);
  const lineTotal = qty * (unitPrice + summary.perUnit);
  const soldOut = item.effectiveSoldOut;

  function submit() {
    setAttempted(true);
    if (!valid || soldOut) return;
    const line = {
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
    };
    if (editing) {
      dispatch({ type: "replace", key: editing.key, line });
      toast("Item updated");
    } else {
      if (lineCount >= GUEST_MAX_LINES) {
        toast(`An order can have up to ${GUEST_MAX_LINES} different items`);
        return;
      }
      dispatch({ type: "add", line });
      toast(`Added ${qty} × ${line.name}`);
    }
    close();
  }

  const priceLabel = variants.length ? `From ${formatMoney(item.effectivePrice)}` : formatMoney(item.effectivePrice);

  return (
    <Sheet
      title={item.name}
      titleExtra={<VegMark veg={item.isVeg} labelled={false} />}
      description={
        <>
          <span>{item.isVeg ? "Vegetarian" : "Non-vegetarian"}</span>
          {item.category?.name ? <span> · {item.category.name}</span> : null}
          <span> · {priceLabel}</span>
        </>
      }
      media={<ItemThumb name={item.name} seed={item.name} large />}
      onClose={close}
      footer={
        <>
          <Stepper value={qty} min={1} max={GUEST_MAX_QTY} onDec={() => setQty((q) => Math.max(1, q - 1))} onInc={() => setQty((q) => Math.min(GUEST_MAX_QTY, q + 1))} label={item.name} light />
          <button type="button" className="sf-btn sf-btn-primary sf-btn-lg" onClick={submit} disabled={soldOut || !orderingOpen && !editing} data-autofocus={groups.length === 0 && variants.length === 0 ? true : undefined}>
            {soldOut ? "Sold out" : editing ? `Update item · ${formatMoney(lineTotal)}` : `Add to cart · ${formatMoney(lineTotal)}`}
          </button>
        </>
      }
    >
      {item.description && <p style={{ margin: "4px 0 0", color: "var(--sf-ink-2)" }}>{item.description}</p>}
      {soldOut && (
        <div className="sf-alert sf-alert-warn" role="status" style={{ marginTop: 12 }}>
          <SfIcon name="alert" />
          <div>This item is sold out right now.</div>
        </div>
      )}

      {variants.length > 0 && (
        <fieldset className="sf-group">
          <legend>
            <span>Choose size</span>
            <small data-required="true">Required · choose 1</small>
          </legend>
          <div className="sf-options">
            {[{ id: undefined as string | undefined, name: "Regular", priceDelta: 0 as number | string }, ...variants].map((v) => {
              const checked = variantId === v.id;
              return (
                <label key={v.id ?? "base"} className="sf-option" data-checked={checked}>
                  <input className="sf-hit" type="radio" name={`size-${item.id}`} checked={checked} onChange={() => setVariantId(v.id)} />
                  <span className="sf-option-mark" data-kind="radio"><SfIcon name="check" strokeWidth={3} /></span>
                  <span className="sf-option-name">{v.name}</span>
                  <span className="sf-option-price">{formatMoney(item.effectivePrice + toNumber(v.priceDelta))}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {groups.map((g) => {
        const chosen = sel[g.id] ?? [];
        const single = g.maxSelect === 1;
        const error = attempted ? errors[g.id] : undefined;
        return (
          <fieldset key={g.id} className="sf-group" aria-describedby={error ? `err-${g.id}` : undefined}>
            <legend>
              <span>{g.name}</span>
              <small data-required={g.minSelect > 0}>{groupRule(g)}</small>
            </legend>
            <div className="sf-options">
              {g.options.map((o) => {
                const on = chosen.includes(o.id);
                const blocked = !on && !single && chosen.length >= g.maxSelect;
                const delta = toNumber(o.priceDelta);
                return (
                  <label key={o.id} className="sf-option" data-checked={on} data-disabled={blocked}>
                    <input
                      className="sf-hit"
                      type={single ? "radio" : "checkbox"}
                      name={`grp-${g.id}`}
                      checked={on}
                      disabled={blocked}
                      onChange={() => setSel((s) => toggleOption(s, g, o.id))}
                      onClick={single && on && g.minSelect === 0 ? () => setSel((s) => ({ ...s, [g.id]: [] })) : undefined}
                    />
                    <span className="sf-option-mark" data-kind={single ? "radio" : "checkbox"}><SfIcon name="check" strokeWidth={3} /></span>
                    <span className="sf-option-name">{o.name}</span>
                    <span className="sf-option-price">{delta > 0 ? `+${formatMoney(delta)}` : delta < 0 ? `−${formatMoney(-delta)}` : "Free"}</span>
                  </label>
                );
              })}
            </div>
            {error && <p id={`err-${g.id}`} role="alert" className="sf-field-error">{error}</p>}
          </fieldset>
        );
      })}

      <label className="sf-field">
        <span className="sf-label">
          Note for the kitchen <small>Optional</small>
        </span>
        <input className="sf-input" name="item-note" value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value.slice(0, 200))} placeholder="e.g. less spicy, no onion" />
      </label>
      {!orderingOpen && !editing && <p className="sf-hint">Ordering is closed right now — you can still look around.</p>}
    </Sheet>
  );
}
