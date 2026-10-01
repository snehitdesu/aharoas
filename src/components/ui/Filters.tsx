"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Input, Select } from "@/components/ui/Form";
import { humanize } from "@/lib/format";

/** Horizontal filter bar that wraps on small screens. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div role="search" className="mb-3 flex flex-wrap items-end gap-2">{children}</div>;
}

/** Debounced search box (search runs server-side). */
export function SearchInput({ value, onChange, placeholder = "Search…", label = "Search", delay = 300 }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string; delay?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft.trim()), delay);
    return () => clearTimeout(t);
  }, [draft, value, onChange, delay]);
  return (
    <label className="relative flex min-w-48 flex-1 items-center sm:max-w-xs">
      <span className="sr-only">{label}</span>
      <Icon name="search" className="pointer-events-none absolute left-2.5 h-4 w-4 text-ink-500" />
      <Input type="search" value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} className="pl-8" maxLength={100} />
    </label>
  );
}

/** Select filter; "" means "any". */
export function SelectFilter({ label, value, onChange, options, anyLabel = "All" }: { label: string; value: string; onChange: (v: string) => void; options: ReadonlyArray<string | { value: string; label: string }>; anyLabel?: string }) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-ink-500">
      <span>{label}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="min-w-36">
        <option value="">{anyLabel}</option>
        {options.map((o) => {
          const opt = typeof o === "string" ? { value: o, label: humanize(o) } : o;
          return <option key={opt.value} value={opt.value}>{opt.label}</option>;
        })}
      </Select>
    </label>
  );
}

export type DateRange = { from: string; to: string };

/** From / to date inputs (YYYY-MM-DD). */
export function DateRangeFilter({ value, onChange }: { value: DateRange; onChange: (v: DateRange) => void }) {
  const invalid = Boolean(value.from && value.to && value.from > value.to);
  return (
    <div className="flex items-end gap-2">
      <label className="flex flex-col gap-0.5 text-xs text-ink-500">
        <span>From</span>
        <Input type="date" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-invalid={invalid} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-ink-500">
        <span>To</span>
        <Input type="date" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-invalid={invalid} />
      </label>
    </div>
  );
}

/**
 * Timestamp bounds for list endpoints that filter a DateTime column: the whole
 * `from` day through the end of the `to` day, in the browser's zone. (Reports
 * take the date-only strings instead and resolve outlet business days server-side.)
 */
export function rangeToQuery(r: DateRange): { from?: string; to?: string } {
  return {
    from: r.from ? new Date(`${r.from}T00:00:00`).toISOString() : undefined,
    to: r.to ? new Date(`${r.to}T23:59:59.999`).toISOString() : undefined,
  };
}
