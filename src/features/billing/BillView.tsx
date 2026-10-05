/**
 * Printable bill / receipt — renders the server's Bill (services/bill.ts) as
 * is; no amount is computed here. Used by the POS bill page (staff) and the
 * guest's digital receipt. A restaurant bill / payment receipt; once paid it
 * shows its invoice number and GST breakdown (GST-ready data), but it is not
 * presented as a certified GST tax invoice.
 */
import type { Bill } from "@/server/services/bill";
import { formatDateTime, formatMoney, formatQty, humanize } from "@/lib/format";

const PAYMENT_STATUS: Record<Bill["paymentStatus"], { label: string; tone: string }> = {
  UNPAID: { label: "Unpaid", tone: "border-warn-500 text-warn-700" },
  PARTIALLY_PAID: { label: "Partially paid", tone: "border-warn-500 text-warn-700" },
  PAID: { label: "Paid", tone: "border-ok-500 text-ok-700" },
  PARTIALLY_REFUNDED: { label: "Paid · partially refunded", tone: "border-ok-500 text-ok-700" },
  REFUNDED: { label: "Refunded", tone: "border-ink-400 text-ink-700" },
  CANCELLED: { label: "Cancelled", tone: "border-bad-500 text-bad-700" },
};

const CHANNEL: Record<string, string> = { DINE_IN: "Dine-in", TAKEAWAY: "Takeaway", DELIVERY: "Delivery", QR: "QR order", ONLINE: "Online", AGGREGATOR: "Aggregator" };

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "text-base font-bold" : "text-sm"}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export function BillView({ bill }: { bill: Bill }) {
  const tz = bill.restaurant.timezone;
  const status = PAYMENT_STATUS[bill.paymentStatus];
  const title = bill.kind === "RECEIPT" ? "Receipt" : "Bill";
  return (
    <article aria-label={`${title} ${bill.billNo}`} className="mx-auto w-full max-w-md bg-paper p-5 text-ink-900 print:max-w-none print:p-0">
      <header className="border-b border-dashed border-ink-300 pb-3 text-center">
        <p className="text-lg font-bold">{bill.restaurant.name}</p>
        <p className="text-sm">{bill.restaurant.outletName}</p>
        {bill.restaurant.address && <p className="text-xs text-ink-600">{bill.restaurant.address}</p>}
        {bill.restaurant.phone && <p className="text-xs text-ink-600">Tel {bill.restaurant.phone}</p>}
        {bill.invoice?.sellerGstin && <p className="text-xs text-ink-600">GSTIN {bill.invoice.sellerGstin}</p>}
      </header>

      <div className="flex items-start justify-between gap-3 border-b border-dashed border-ink-300 py-3">
        <div className="text-sm">
          <h2 className="text-base font-bold uppercase tracking-wide">{title}</h2>
          <p>
            No. <span className="font-mono font-semibold">{bill.billNo}</span>
          </p>
          <p>{bill.table ? `Table ${bill.table}` : CHANNEL[bill.channel] ?? humanize(bill.channel)}{bill.table && bill.channel === "QR" ? " · QR order" : ""}</p>
          <p className="text-ink-600">{formatDateTime(bill.createdAt, tz)}</p>
          {bill.invoice && <p>Invoice <span className="font-mono font-semibold" data-testid="invoice-number">{bill.invoice.number}</span> · {formatDateTime(bill.invoice.issuedAt, tz)}</p>}
          {bill.invoice?.buyerGstin && <p className="text-xs">Buyer {bill.invoice.buyerName ?? ""} · GSTIN {bill.invoice.buyerGstin}</p>}
        </div>
        <span className={`rounded border-2 px-2 py-1 text-xs font-bold uppercase tracking-wide ${status.tone}`} data-testid="bill-payment-status">{status.label}</span>
      </div>

      <table className="w-full border-b border-dashed border-ink-300 text-sm" aria-label="Items">
        <thead>
          <tr className="text-left text-xs uppercase text-ink-600">
            <th className="py-2 font-semibold">Item</th>
            <th className="py-2 text-right font-semibold">Qty</th>
            <th className="py-2 text-right font-semibold">Rate</th>
            <th className="py-2 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l, i) => (
            <tr key={i} className="align-top">
              <td className="py-1 pr-2">
                {l.name}
                {l.modifiers.map((m) => (
                  <span key={m.name} className="block text-xs text-ink-600">
                    + {m.name}{Number(m.priceDelta) ? ` (${formatMoney(m.priceDelta)})` : ""}
                  </span>
                ))}
                {Number(l.discount) > 0 && <span className="block text-xs text-ink-600">Discount −{formatMoney(l.discount)}</span>}
              </td>
              <td className="py-1 text-right tabular-nums">{formatQty(l.qty)}</td>
              <td className="py-1 text-right tabular-nums">{formatMoney(l.unitPrice)}</td>
              <td className="py-1 text-right tabular-nums">{formatMoney(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="space-y-1 border-b border-dashed border-ink-300 py-3" aria-label="Totals">
        <Row label="Subtotal" value={formatMoney(bill.subtotal)} />
        {Number(bill.discount) > 0 && <Row label="Discount" value={`−${formatMoney(bill.discount)}`} />}
        {bill.invoice && bill.invoice.supplyType !== "UNREGISTERED"
          ? bill.invoice.lines.flatMap((l) => {
              const half = String(Number(l.ratePct) / 2);
              return l.ratePct === "0" ? [] : Number(l.igst) > 0
                ? [<Row key={`i${l.ratePct}`} label={`IGST ${l.ratePct}% on ${formatMoney(l.taxable)}`} value={formatMoney(l.igst)} />]
                : [<Row key={`c${l.ratePct}`} label={`CGST ${half}% on ${formatMoney(l.taxable)}`} value={formatMoney(l.cgst)} />, <Row key={`s${l.ratePct}`} label={`SGST ${half}%`} value={formatMoney(l.sgst)} />];
            })
          : bill.taxes.map((t) => (
              <Row key={t.ratePct} label={`Tax ${t.ratePct}% on ${formatMoney(t.taxable)}`} value={formatMoney(t.amount)} />
            ))}
        <Row label="Total" value={formatMoney(bill.total)} strong />
      </dl>

      <dl className="space-y-1 py-3" aria-label="Payments">
        {bill.payments.map((p, i) => (
          <Row key={i} label={`${humanize(p.method)}${p.status === "SUCCESS" ? "" : ` (${humanize(p.status)})`} · ${formatDateTime(p.at, tz)}`} value={formatMoney(p.amount)} />
        ))}
        {bill.refunds.map((r, i) => (
          <Row key={`r${i}`} label={`Refund · ${formatDateTime(r.at, tz)}`} value={`−${formatMoney(r.amount)}`} />
        ))}
        <Row label="Paid" value={formatMoney(bill.paid)} />
        {Number(bill.refunded) > 0 && <Row label="Refunded" value={formatMoney(bill.refunded)} />}
        {bill.paymentStatus !== "CANCELLED" && bill.paymentStatus !== "REFUNDED" && <Row label="Balance due" value={formatMoney(bill.balanceDue)} strong />}
        {bill.creditNotes.map((c) => <Row key={c.number} label={`Credit note ${c.number}`} value={`−${formatMoney(c.total)}`} />)}
      </dl>

      <footer className="border-t border-dashed border-ink-300 pt-3 text-center text-xs text-ink-600">
        <p>{bill.paidAt ? `Paid ${formatDateTime(bill.paidAt, tz)}` : "Thank you!"}</p>
        <p>{bill.invoice ? "Invoice data for GST records — not a certified tax invoice (no e-invoice IRN / digital signature)." : "This is a bill / payment receipt, not a tax invoice."}</p>
      </footer>
    </article>
  );
}
