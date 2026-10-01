"use client";

import type { TableDTO } from "@/features/pos/types";
import { Dialog } from "@/components/ui/Dialog";

const STATUS_STYLE: Record<string, string> = {
  AVAILABLE: "border-green-300 bg-ok-100 text-green-900",
  RESERVED: "border-amber-300 bg-warn-100 text-amber-900",
  CLEANING: "border-ink-300 bg-ink-100 text-ink-500",
};
const busy = "border-red-300 bg-bad-100 text-red-900";

/** Tables grouped by floor with live status; occupied tables open their running order. */
export function TablePicker({ tables, selectedId, onSelect, onClose }: { tables: TableDTO[]; selectedId: string | null; onSelect: (t: TableDTO) => void; onClose: () => void }) {
  const floors = new Map<string, TableDTO[]>();
  for (const t of tables) {
    const f = t.floor?.name ?? "Main";
    floors.set(f, [...(floors.get(f) ?? []), t]);
  }
  return (
    <Dialog open onClose={onClose} title="Choose table" description="Occupied tables open their running order" size="lg">
      {tables.length === 0 ? (
        <p className="text-sm text-ink-500">No tables are set up for this outlet.</p>
      ) : (
        <div className="space-y-4">
          {[...floors.entries()].map(([floor, list]) => (
            <section key={floor} aria-label={floor}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{floor}</h3>
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {list.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(t)}
                      disabled={t.status === "CLEANING"}
                      aria-pressed={selectedId === t.id}
                      aria-label={`Table ${t.code}, ${t.capacity} seats, ${t.status.toLowerCase().replace("_", " ")}`}
                      className={`flex h-16 w-full flex-col items-center justify-center rounded-md border text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed ${STATUS_STYLE[t.status] ?? busy} ${selectedId === t.id ? "ring-2 ring-brand-600" : ""}`}
                    >
                      {t.code}
                      <span className="text-[11px] font-normal">{t.capacity} seats · {t.status === "AVAILABLE" ? "free" : t.status.toLowerCase().replace("_", " ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
