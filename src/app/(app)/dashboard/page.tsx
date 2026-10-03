import Link from "next/link";
import { prisma } from "@/server/db/client";
import { requireShell } from "@/lib/auth/shell";
import { salesSummary } from "@/server/services/analytics";
import { countOrders } from "@/server/services/orders";
import { kitchenTicketCounts } from "@/server/services/kot";
import { countOpenReservations } from "@/server/services/reservations";
import { listAnomalies } from "@/server/services/anomaly";
import { listTables } from "@/server/services/masterData";
import { lowStock } from "@/server/services/inventory";
import { businessDayRange } from "@/domain/time";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — Aharos" };

type Tile<T> = { ok: true; value: T } | { ok: false } | null;

/** Run a tile query only if permitted; a failure degrades that tile, not the page. */
async function tile<T>(allowed: boolean, fn: () => Promise<T>): Promise<Tile<T>> {
  if (!allowed) return null;
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

function Stat({ label, value, hint, emphasis = false, tone = "brand" }: { label: string; value: React.ReactNode; hint?: string; emphasis?: boolean; tone?: "brand" | "accent" | "ok" | "warn" | "bad" | "neutral" }) {
  const rail = { brand: "before:bg-brand-500", accent: "before:bg-vanilla-300", ok: "before:bg-ok-500", warn: "before:bg-warn-500", bad: "before:bg-bad-500", neutral: "before:bg-ink-300" }[tone];
  return (
    <div className={`relative overflow-hidden rounded-xl border bg-white p-4 shadow-card before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${rail} ${emphasis ? "border-ink-300 sm:p-5" : "border-ink-200"}`}>
      <p className="pl-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <p className={`mt-1.5 pl-1.5 font-semibold tabular-nums tracking-[-0.02em] text-ink-900 ${emphasis ? "text-[1.75rem] leading-8" : "text-2xl"}`}>{value}</p>
      {hint && <p className="mt-1 pl-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

const unavailable = <span className="text-base font-normal text-bad-500">Unavailable</span>;

export default async function DashboardPage() {
  const { shell, ctx } = await requireShell("/dashboard");
  const outlet = shell.outlets.find((o) => o.id === shell.outletId);
  if (!outlet) {
    return <p className="text-sm text-ink-500">You don&apos;t have access to any active outlet yet. Ask a manager to add you to an outlet.</p>;
  }
  const has = new Set(shell.permissions);
  const today = businessDayRange(new Date(), outlet.timezone);

  const [sales, openOrderCount, kitchen, openBookings, anomalies, tables, stockAlerts] = await Promise.all([
    tile(has.has("reports.view"), () => salesSummary(prisma, ctx, { outletId: outlet.id, from: today.start, to: new Date(today.end.getTime() - 1) })),
    tile(has.has("order.view"), () => countOrders(prisma, ctx, { outletId: outlet.id, active: true })),
    tile(has.has("kot.view"), () => kitchenTicketCounts(prisma, ctx, outlet.id)),
    tile(has.has("reservation.manage"), () => countOpenReservations(prisma, ctx, { outletId: outlet.id, from: today.start, to: today.end })),
    tile(has.has("anomaly.view"), () => listAnomalies(prisma, ctx, { outletId: outlet.id, status: "OPEN", take: 5 })),
    tile(has.has("order.view") || has.has("reservation.manage") || has.has("outlet.manage"), () => listTables(prisma, ctx, outlet.id)),
    tile(has.has("inventory.view"), () => lowStock(prisma, ctx, outlet.id)),
  ]);

  const availableTables = tables?.ok ? tables.value.filter((t) => t.status === "AVAILABLE").length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-700">Today&apos;s operations</p>
          <h1 className="text-xl font-semibold tracking-tight">{outlet.name}</h1>
          <p className="text-sm text-ink-500">Business day {today.date} · {outlet.timezone}</p>
        </div>
        <div className="flex gap-2">
          {has.has("order.create") && (
            <Link href="/pos" className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white shadow-xs hover:bg-brand-700">
              Open POS
            </Link>
          )}
          {has.has("kot.view") && (
            <Link href="/kitchen" className="inline-flex h-10 items-center rounded-md border border-ink-300 bg-white px-4 text-sm font-medium text-ink-800 shadow-xs hover:bg-ink-50">
              Kitchen display
            </Link>
          )}
        </div>
      </div>

      <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {sales && <Stat emphasis tone="accent" label="Net sales today" value={sales.ok ? formatMoney(sales.value.netSales) : unavailable} hint={sales.ok ? `${sales.value.orders} paid orders · AOV ${formatMoney(sales.value.aov)}` : undefined} />}
        {openOrderCount && <Stat tone="brand" label="Open orders" value={openOrderCount.ok ? openOrderCount.value : unavailable} hint="Not yet paid or cancelled" />}
        {kitchen && <Stat tone={kitchen.ok && kitchen.value.ready > 0 ? "ok" : "brand"} label="Kitchen tickets" value={kitchen.ok ? kitchen.value.total : unavailable} hint={kitchen.ok ? `${kitchen.value.ready} ready to serve` : undefined} />}
        {openBookings && <Stat tone="neutral" label="Reservations today" value={openBookings.ok ? openBookings.value : unavailable} hint="Booked, confirmed or seated" />}
      </section>

      {(sales || tables || stockAlerts) && (
        <section aria-label="Supporting metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {sales && <Stat tone="accent" label="Average order value" value={sales.ok ? formatMoney(sales.value.aov) : unavailable} hint="Paid orders today" />}
          {tables && <Stat tone="ok" label="Open tables" value={tables.ok ? `${availableTables} / ${tables.value.length}` : unavailable} hint="Available now" />}
          {stockAlerts && <Stat tone={stockAlerts.ok && stockAlerts.value.length > 0 ? "warn" : "ok"} label="Low stock" value={stockAlerts.ok ? stockAlerts.value.length : unavailable} hint="At or below reorder level" />}
        </section>
      )}

      {anomalies && (
        <section aria-labelledby="anomalies-h" className="rounded-xl border border-ink-200 bg-white shadow-card">
          <h2 id="anomalies-h" className="border-b border-ink-200 px-4 py-2.5 text-sm font-semibold tracking-[-0.01em]">Open anomalies</h2>
          {!anomalies.ok ? (
            <p className="px-4 py-3 text-sm text-bad-500">Couldn&apos;t load anomalies.</p>
          ) : anomalies.value.items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-500">Nothing needs attention.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {anomalies.value.items.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <Badge tone={a.severity === "HIGH" || a.severity === "CRITICAL" ? "bad" : "warn"}>{a.severity}</Badge>
                  <span className="text-ink-700">{a.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!sales && !openOrderCount && !kitchen && !openBookings && !anomalies && (
        <p className="text-sm text-ink-500">Your role has no dashboard widgets at this outlet. Use the navigation to reach your screens.</p>
      )}
    </div>
  );
}
