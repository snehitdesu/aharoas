"use client";

import { forwardRef, useMemo, useState } from "react";
import type { MenuItemDTO } from "@/features/pos/types";
import { needsConfiguration } from "@/features/pos/modifiers";
import { formatMoney } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";

type Props = { items: MenuItemDTO[]; onPick: (item: MenuItemDTO) => void };

/** Category tabs + search + item grid. Sold-out / not-offered items are visible but not selectable. */
export const MenuPanel = forwardRef<HTMLInputElement, Props>(function MenuPanel({ items, onPick }, searchRef) {
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");

  const categories = useMemo(() => {
    const map = new Map<string, { id: string; name: string; sortOrder: number }>();
    for (const i of items) if (i.category) map.set(i.category.id, i.category);
    return [...map.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => (category === "all" || i.categoryId === category) && (!q || i.name.toLowerCase().includes(q)));
  }, [items, category, query]);

  const available = (i: MenuItemDTO) => i.offered && !i.effectiveSoldOut;

  return (
    <section aria-label="Menu" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-ink-200 bg-white p-2">
        <label className="relative flex-1">
          <span className="sr-only">Search menu</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = visible.find(available);
                if (first) {
                  onPick(first);
                  setQuery("");
                }
              }
            }}
            placeholder="Search menu  ( / )"
            className="h-10 w-full rounded-md border border-ink-300 pl-8 pr-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          />
        </label>
      </div>

      <div role="tablist" aria-label="Categories" className="flex gap-1 overflow-x-auto border-b border-ink-200 bg-white px-2 py-1.5">
        {[{ id: "all", name: "All" }, ...categories].map((c) => (
          <button
            key={c.id}
            role="tab"
            type="button"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
            className={`h-9 shrink-0 rounded-md px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${category === c.id ? "bg-brand-600 text-white" : "text-ink-700 hover:bg-ink-100"}`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-500">{items.length === 0 ? "No menu items are offered at this outlet." : "No items match."}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visible.map((item) => {
              const ok = available(item);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={!ok}
                    onClick={() => onPick(item)}
                    aria-label={`${item.name}, ${formatMoney(item.effectivePrice)}${ok ? "" : item.offered ? ", sold out" : ", not offered here"}`}
                    className="flex h-24 w-full flex-col justify-between rounded-lg border border-ink-200 bg-white p-2.5 text-left shadow-xs transition-colors hover:border-brand-500 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:bg-ink-100 disabled:opacity-60"
                  >
                    <span className="flex items-start gap-1.5">
                      <span aria-hidden className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-sm border ${item.isVeg ? "border-ok-500 bg-ok-500/70" : "border-bad-500 bg-bad-500/70"}`} />
                      <span className="line-clamp-2 text-sm font-medium leading-snug text-ink-900">{item.name}</span>
                    </span>
                    <span className="flex items-center justify-between text-xs">
                      <span className="font-semibold tabular-nums text-ink-700">{formatMoney(item.effectivePrice)}</span>
                      {!ok ? <span className="font-medium text-bad-500">{item.offered ? "Sold out" : "N/A"}</span> : needsConfiguration(item) ? <span className="text-ink-500">Options</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
});
