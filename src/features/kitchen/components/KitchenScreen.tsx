"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError } from "@/lib/api/client";
import { createPoller, type Poller } from "@/lib/polling";
import { KDS_COLUMNS, groupTickets, type KdsTicket } from "@/features/kitchen/kds";
import type { KOTStatus } from "@/constants/enums";
import { TicketCard } from "@/features/kitchen/components/TicketCard";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

type Station = { id: string; name: string; kind: string };
const INTERVALS = [5, 10, 20, 30];

/**
 * Kitchen display. Transport: polling (the backend has no push channel yet) via
 * createPoller — no overlapping requests, pauses while the tab is hidden,
 * refreshes on return and after every action. Station filtering is applied by
 * the server (GET /api/kitchen/kots?stationId=…), which also enforces kot.view.
 */
export function KitchenScreen({ outletId, canUpdate }: { outletId: string; canUpdate: boolean }) {
  const toast = useToast();
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState<string>("all");
  const [intervalSec, setIntervalSec] = useState(10);
  const [tickets, setTickets] = useState<KdsTicket[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const poller = useRef<Poller | null>(null);

  useEffect(() => {
    api<Station[]>("/api/kitchen/stations", { query: { outletId } }).then(setStations).catch(() => setStations([]));
  }, [outletId]);

  useEffect(() => {
    setTickets(null);
    const p = createPoller<KdsTicket[]>({
      intervalMs: intervalSec * 1000,
      fetch: (signal) => api<KdsTicket[]>("/api/kitchen/kots", { query: { outletId, stationId: stationId === "all" ? undefined : stationId }, signal }),
      onData: (data) => {
        setTickets(data);
        setError(null);
        setLastUpdated(Date.now());
      },
      onError: (e) => setError(e),
    });
    poller.current = p;
    p.start();
    return () => p.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interval changes are applied below without restarting
  }, [outletId, stationId]);

  useEffect(() => poller.current?.setInterval(intervalSec * 1000), [intervalSec]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000); // ticket age display only
    return () => clearInterval(t);
  }, []);

  const columns = useMemo(() => groupTickets(tickets ?? []), [tickets]);

  async function act(ticket: KdsTicket, to: KOTStatus) {
    if (pending.has(ticket.id)) return;
    setPending((s) => new Set(s).add(ticket.id));
    try {
      await api(`/api/kitchen/kots/${ticket.id}/status`, { method: "POST", body: { status: to } });
      await poller.current?.refresh(); // show the server's state, not an assumed one
    } catch (e) {
      if (e instanceof ApiError && e.kind === "unauthorized") window.location.href = "/login?next=/kitchen";
      toast.show(`KOT ${ticket.number}: ${describeError(e)}`, "bad");
      await poller.current?.refresh();
    } finally {
      setPending((s) => {
        const n = new Set(s);
        n.delete(ticket.id);
        return n;
      });
    }
  }

  const stale = error !== null && tickets !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-200 bg-white px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          Station
          <select value={stationId} onChange={(e) => setStationId(e.target.value)} className="h-9 rounded-md border border-ink-300 bg-white px-2 text-sm">
            <option value="all">All stations</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Refresh
          <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} className="h-9 rounded-md border border-ink-300 bg-white px-2 text-sm">
            {INTERVALS.map((s) => (
              <option key={s} value={s}>every {s}s</option>
            ))}
          </select>
        </label>
        <p className="ml-auto text-xs text-ink-500" aria-live="polite">
          {stale ? <span className="font-semibold text-bad-500">Connection problem — showing last known tickets. {describeError(error)}</span> : lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : "Connecting…"}
        </p>
      </div>

      {tickets === null ? (
        error ? <ErrorState error={error} onRetry={() => void poller.current?.refresh()} /> : <LoadingState label="Loading tickets…" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-3">
          {KDS_COLUMNS.map((col) => (
            <section key={col.id} aria-labelledby={`col-${col.id}`} className={`flex min-h-0 flex-col rounded-xl border bg-ink-50 ${col.id === "ready" ? "border-ok-100" : col.id === "new" ? "border-brand-100" : "border-ink-200"}`}>
              <h2 id={`col-${col.id}`} className="flex items-center justify-between px-3 py-2 text-sm font-bold uppercase tracking-wide text-ink-700">
                {col.title}
                <span className="rounded-full bg-white px-2 text-xs tabular-nums shadow-xs">{columns[col.id].length}</span>
              </h2>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2">
                {columns[col.id].length === 0 ? (
                  <p className="p-4 text-center text-sm text-ink-500">No tickets</p>
                ) : (
                  columns[col.id].map((t) => <TicketCard key={t.id} ticket={t} now={now} pending={pending.has(t.id)} canUpdate={canUpdate} onAction={(to) => void act(t, to)} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
