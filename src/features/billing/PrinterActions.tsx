"use client";

import { useState } from "react";
import { api, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";

type Job = { status: string; duplicate: boolean; lastError: string | null };

/**
 * Send the bill to the outlet's receipt printer. The first print happens once
 * (a second tap returns the same job); a reprint needs a reason and is
 * audited. Shown only when a receipt printer is configured (the page checks).
 */
export function PrinterActions({ orderId }: { orderId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [askReason, setAskReason] = useState(false);
  const send = async (reprint: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const job = await api<Job>(`/api/print/orders/${orderId}/receipt`, { method: "POST", body: reprint ? { reprint: true, reason: reason.trim() } : {} });
      if (job.duplicate) {
        setMsg(`Already sent to the printer (${job.status.toLowerCase()}). Use Reprint for another copy.`);
        setAskReason(true);
      } else setMsg(job.status === "PRINTED" ? "Printed." : job.status === "SIMULATED" ? "Simulated printer: nothing was printed on paper." : `Print failed: ${job.lastError ?? "printer unavailable"}. Retry from Printers.`);
      if (reprint) setAskReason(false);
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1 print:hidden" data-testid="printer-actions">
      <div className="flex gap-2">
        <Button onClick={() => send(false)} loading={busy && !askReason}>Send to printer</Button>
        {askReason && (
          <>
            <input aria-label="Reprint reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className="h-9 w-32 rounded-md border border-ink-300 px-2 text-sm" />
            <Button onClick={() => send(true)} disabled={reason.trim().length < 3} loading={busy && askReason}>Reprint</Button>
          </>
        )}
      </div>
      {msg && <p role="status" className="text-xs text-ink-600">{msg}</p>}
    </div>
  );
}
