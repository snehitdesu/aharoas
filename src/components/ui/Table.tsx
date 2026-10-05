"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/States";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Numbers / money: right-aligned, tabular figures. */
  numeric?: boolean;
  className?: string;
};

/**
 * Dense data table with built-in loading / error / empty states. Rows are
 * clickable (and keyboard-activatable with Enter) when `onRowClick` is given.
 * Data already on screen stays visible while a reload runs.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  onRetry,
  empty = "Nothing here yet",
  emptyHint,
  onRowClick,
  label,
  footer,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: string;
  emptyHint?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Accessible name of the table. */
  label: string;
  footer?: ReactNode;
}) {
  if (error) return <div className="rounded-lg border border-ink-200 bg-paper shadow-card"><ErrorState error={error} onRetry={onRetry} /></div>;
  return (
    <div className="relative overflow-x-auto rounded-lg border border-ink-200 bg-paper shadow-card">
      <table className="w-full min-w-max border-collapse text-sm" aria-label={label} aria-busy={loading || undefined}>
        <thead>
          <tr className="sticky top-0 z-10 border-b-2 border-ink-800 bg-paper-warm text-left text-[11px] font-semibold uppercase tracking-eyebrow text-ink-600">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-3.5 py-2.5 ${c.numeric ? "text-right" : ""} ${c.className ?? ""}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === "Enter" && e.target === e.currentTarget && onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={`border-b border-ink-200/70 last:border-0 ${onRowClick ? "cursor-pointer transition-colors hover:bg-vanilla-50 focus-visible:bg-brand-50 focus-visible:outline-none" : ""}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-3.5 py-2.5 align-top ${c.numeric ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot className="border-t-2 border-ink-800 bg-paper-warm font-semibold">{footer}</tfoot>}
      </table>
      {rows.length === 0 && (loading ? <div className="flex justify-center p-6"><Spinner /></div> : <EmptyState title={empty} hint={typeof emptyHint === "string" ? emptyHint : undefined} action={typeof emptyHint === "string" ? undefined : emptyHint} />)}
      {loading && rows.length > 0 && <div className="pointer-events-none absolute right-2 top-2"><Spinner label="Refreshing" /></div>}
    </div>
  );
}

/** Previous / next pager for cursor-paginated lists (see usePaged). */
export function Pager({ page, hasPrev, hasNext, prev, next }: { page: number; hasPrev: boolean; hasNext: boolean; prev: () => void; next: () => void }) {
  if (!hasPrev && !hasNext) return null;
  return (
    <nav aria-label="Pagination" className="mt-2 flex items-center justify-end gap-2 text-sm">
      <Button size="sm" onClick={prev} disabled={!hasPrev} aria-label="Previous page">
        <Icon name="chevronLeft" /> Prev
      </Button>
      <span className="tabular-nums text-ink-500">Page {page}</span>
      <Button size="sm" onClick={next} disabled={!hasNext} aria-label="Next page">
        Next <Icon name="chevronRight" />
      </Button>
    </nav>
  );
}
