"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { humanize } from "@/lib/format";

/** Screen title row: optional back link, title, subtitle, actions. */
export function PageHeader({ title, subtitle, back, actions, badge }: { title: ReactNode; subtitle?: ReactNode; back?: { href: string; label: string }; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-1 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-900">
            <Icon name="chevronLeft" /> {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Link-based tabs for sibling screens. */
export function SubNav({ items, label }: { items: Array<{ href: string; label: string; hidden?: boolean }>; label: string }) {
  const pathname = usePathname();
  const visible = items.filter((i) => !i.hidden);
  if (visible.length < 2) return null;
  return (
    <nav aria-label={label} className="mb-4 flex gap-1 overflow-x-auto border-b border-ink-300">
      {visible.map((i) => {
        const active = pathname === i.href;
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${active ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-ink-500 hover:text-ink-900"}`}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** In-page tabs (state-based). */
export function Tabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string; hidden?: boolean }>; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="mb-3 flex gap-1 overflow-x-auto border-b border-ink-300">
      {options.filter((o) => !o.hidden).map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${value === o.value ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-ink-500 hover:text-ink-900"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-ink-300 bg-white ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-ink-300 px-4 py-2.5">
          {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Label / value grid for detail views. */
export function Details({ items, cols = 3 }: { items: Array<[ReactNode, ReactNode] | null | false>; cols?: 2 | 3 | 4 }) {
  const grid = cols === 2 ? "sm:grid-cols-2" : cols === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3";
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-3 ${grid}`}>
      {items.filter(Boolean).map((it, i) => {
        const [k, v] = it as [ReactNode, ReactNode];
        return (
          <div key={i} className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{k}</dt>
            <dd className="mt-0.5 break-words text-sm text-ink-900">{v ?? "—"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "bad" | "ok" }) {
  return (
    <div className="rounded-lg border border-ink-300 bg-white p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone === "bad" ? "text-bad-500" : tone === "ok" ? "text-ok-500" : "text-ink-900"}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

const TONE: Record<string, "neutral" | "info" | "ok" | "warn" | "bad"> = {
  // generic lifecycle
  DRAFT: "neutral", OPEN: "info", PENDING: "warn", SUBMITTED: "warn", APPROVED: "ok", POSTED: "ok", COMPLETED: "ok", CLOSED: "neutral", CANCELLED: "neutral",
  // procurement
  ORDERED: "info", PARTIAL: "warn", RECEIVED: "ok", BILLED: "info", PAID: "ok",
  // stock
  DISPATCHED: "info", ISSUED: "ok", COUNTING: "info", REVIEW: "warn", IN_PROGRESS: "info",
  // payments / jobs
  SUCCESS: "ok", FAILED: "bad", REFUNDED: "warn", RUNNING: "info",
  // recipes
  ARCHIVED: "neutral",
  // reservations / waitlist
  BOOKED: "info", CONFIRMED: "ok", SEATED: "info", NO_SHOW: "bad", WAITING: "warn", ARRIVED: "info", LEFT: "neutral",
  // anomalies
  ACKNOWLEDGED: "warn", RESOLVED: "ok", DISMISSED: "neutral", LOW: "neutral", MEDIUM: "warn", HIGH: "bad", CRITICAL: "bad",
  // tables
  AVAILABLE: "ok", OCCUPIED: "info", ORDERING: "info", PREPARING: "info", READY: "ok", BILL_REQUESTED: "warn", RESERVED: "warn", CLEANING: "neutral",
  // staff
  PRESENT: "ok", LATE: "warn", ABSENT: "bad", LEAVE: "neutral", REJECTED: "bad", DONE: "ok", VERIFIED: "ok",
  ACTIVE: "ok", INACTIVE: "neutral",
};

/** Consistent status badge for any workflow status string. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-ink-500">—</span>;
  return <Badge tone={TONE[status] ?? "neutral"}>{humanize(status)}</Badge>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <StatusBadge status={active ? "ACTIVE" : "INACTIVE"} />;
}
