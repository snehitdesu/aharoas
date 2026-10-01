import Link from "next/link";
import { prisma } from "@/server/db/client";
import { requireShell } from "@/lib/auth/shell";
import { salesSummary } from "@/server/services/analytics";
import { listOrders } from "@/server/services/orders";
import { listKOTs } from "@/server/services/kot";
import { listReservations } from "@/server/services/reservations";
import { listAnomalies } from "@/server/services/anomaly";
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

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-ink-300 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
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

  const [sales, orders, kots, reservations, anomalies] = await Promise.all([
    tile(has.has("reports.view"), () => salesSummary(prisma, ctx, { outletId: outlet.id, from: today.start, to: new Date(today.end.getTime() - 1) })),
    tile(has.has("order.view"), () => listOrders(prisma, ctx, { outletId: outlet.id, active: true, take: 200 })),
    tile(has.has("kot.view"), () => listKOTs(prisma, ctx, { outletId: outlet.id })),
    tile(has.has("reservation.manage"), () => listReservations(prisma, ctx, { outletId: outlet.id, from: today.start, to: today.end, take: 200 })),
    tile(has.has("anomaly.view"), () => listAnomalies(prisma, ctx, { outletId: outlet.id, status: "OPEN", take: 5 })),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{outlet.name}</h1>
          <p className="text-sm text-ink-500">Business day {today.date} · {outlet.timezone}</p>
        </div>
        <div className="flex gap-2">
          {has.has("order.create") && <Link href="/pos" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Open POS</Link>}
          {has.has("kot.view") && <Link href="/kitchen" className="rounded-md border border-ink-300 bg-white px-4 py-2 text-sm font-medium hover:bg-ink-100">Kitchen display</Link>}
        </div>
      </div>

      <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {sales && <Stat label="Net sales today" value={sales.ok ? formatMoney(sales.value.netSales) : unavailable} hint={sales.ok ? `${sales.value.orders} paid orders · AOV ${formatMoney(sales.value.aov)}` : undefined} />}
        {orders && <Stat label="Open orders" value={orders.ok ? `${orders.value.items.length}${orders.value.nextCursor ? "+" : ""}` : unavailable} hint="Not yet paid or cancelled" />}
        {kots && <Stat label="Kitchen tickets" value={kots.ok ? kots.value.length : unavailable} hint={kots.ok ? `${kots.value.filter((k) => k.status === "READY").length} ready to serve` : undefined} />}
        {reservations && <Stat label="Reservations today" value={reservations.ok ? reservations.value.items.filter((r) => ["BOOKED", "CONFIRMED", "SEATED"].includes(r.status)).length : unavailable} hint="Booked, confirmed or seated" />}
      </section>

      {anomalies && (
        <section aria-labelledby="anomalies-h" className="rounded-lg border border-ink-300 bg-white">
          <h2 id="anomalies-h" className="border-b border-ink-300 px-4 py-2.5 text-sm font-semibold">Open anomalies</h2>
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

      {!sales && !orders && !kots && !reservations && !anomalies && (
        <p className="text-sm text-ink-500">Your role has no dashboard widgets at this outlet. Use the navigation to reach your screens.</p>
      )}
    </div>
  );
}
