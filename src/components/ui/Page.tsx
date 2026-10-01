"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { humanize } from "@/lib/format";

/** Screen title row: optional back link, title, subtitle, actions. */
export function PageHeader({ title, subtitle, back, actions, badge }: { title: ReactNode; subtitle?: ReactNode; back?: { href: string; label: string }; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-1 inline-flex items-center gap-1 text-sm font-medium text-ink-500 transition-colors hover:text-brand-600">
            <Icon name="chevronLeft" /> {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.35rem] font-semibold leading-tight tracking-[-0.02em] text-ink-900">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
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
    <nav aria-label={label} className="mb-5 flex gap-1 overflow-x-auto border-b border-ink-200">
      {visible.map((i) => {
        const active = pathname === i.href;
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${active ? "border-brand-500 font-semibold text-brand-700" : "border-transparent font-medium text-ink-500 hover:border-ink-300 hover:text-ink-800"}`}>
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
    <div role="tablist" aria-label={label} className="mb-4 flex gap-1 overflow-x-auto border-b border-ink-200">
      {options.filter((o) => !o.hidden).map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${value === o.value ? "border-brand-500 font-semibold text-brand-700" : "border-transparent font-medium text-ink-500 hover:border-ink-300 hover:text-ink-800"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, actions, children, className = "", bodyClassName = "p-4" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`rounded-xl border border-ink-200 bg-white shadow-card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-4 py-3">
          {title && <h2 className="text-sm font-semibold tracking-[-0.01em] text-ink-900">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Label / value grid for detail views. */
export function Details({ items, cols = 3 }: { items: Array<[ReactNode, ReactNode] | null | false>; cols?: 2 | 3 | 4 }) {
  const grid = cols === 2 ? "sm:grid-cols-2" : cols === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3";
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-4 ${grid}`}>
      {items.filter(Boolean).map((it, i) => {
        const [k, v] = it as [ReactNode, ReactNode];
        return (
          <div key={i} className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">{k}</dt>
            <dd className="mt-1 break-words text-sm text-ink-900">{v ?? "—"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "bad" | "ok" }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-card">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums tracking-[-0.02em] ${tone === "bad" ? "text-bad-600" : tone === "ok" ? "text-ok-600" : "text-ink-900"}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

type MetricTone = "brand" | "accent" | "neutral" | "ok" | "warn" | "bad";
const METRIC_ACCENT: Record<MetricTone, string> = {
  brand: "before:bg-brand-500",
  accent: "before:bg-vanilla-300",
  neutral: "before:bg-ink-300",
  ok: "before:bg-ok-500",
  warn: "before:bg-warn-500",
  bad: "before:bg-bad-500",
};
const METRIC_ICON: Record<MetricTone, string> = {
  brand: "bg-brand-50 text-brand-600",
  accent: "bg-vanilla-100 text-vanilla-700",
  neutral: "bg-ink-100 text-ink-600",
  ok: "bg-ok-50 text-ok-600",
  warn: "bg-warn-50 text-warn-600",
  bad: "bg-bad-50 text-bad-600",
};

/**
 * Dashboard KPI card with a left accent rail, optional icon and emphasis.
 * `emphasis` lifts a primary metric above supporting ones.
 */
export function MetricCard({ label, value, hint, icon, tone = "neutral", emphasis = false, href }: { label: string; value: ReactNode; hint?: ReactNode; icon?: IconName; tone?: MetricTone; emphasis?: boolean; href?: string }) {
  const body = (
    <div
      className={`relative overflow-hidden rounded-xl border bg-white p-4 shadow-card transition-shadow before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${METRIC_ACCENT[tone]} ${emphasis ? "border-ink-300 sm:p-5" : "border-ink-200"} ${href ? "hover:shadow-raised" : ""}`}
    >
      <div className="flex items-start justify-between gap-3 pl-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">{label}</p>
        {icon && (
          <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${METRIC_ICON[tone]}`}>
            <Icon name={icon} className="h-4 w-4" />
          </span>
        )}
      </div>
      <p className={`mt-1.5 pl-1.5 font-semibold tabular-nums tracking-[-0.02em] text-ink-900 ${emphasis ? "text-[1.75rem] leading-8" : "text-2xl"}`}>{value}</p>
      {hint && <p className="mt-1 pl-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
      {body}
    </Link>
  ) : (
    body
  );
}

const TONE: Record<string, "neutral" | "info" | "brand" | "accent" | "ok" | "warn" | "bad"> = {
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
