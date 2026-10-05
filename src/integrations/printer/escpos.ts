/**
 * ESC/POS rendering (pure functions — no I/O). Produces the printer byte stream
 * for receipts, kitchen tickets, test pages and the cash-drawer kick from the
 * same Bill / KOT data the screens use, so a paper receipt never differs from
 * the on-screen bill. Text is reduced to printable ASCII (₹ → "Rs.") because
 * thermal printers' default code page has no rupee sign.
 */
import type { Bill } from "@/server/services/bill";

export const ESC = {
  init: [0x1b, 0x40],
  boldOn: [0x1b, 0x45, 0x01],
  boldOff: [0x1b, 0x45, 0x00],
  center: [0x1b, 0x61, 0x01],
  left: [0x1b, 0x61, 0x00],
  doubleOn: [0x1d, 0x21, 0x11],
  doubleOff: [0x1d, 0x21, 0x00],
  feed3: [0x1b, 0x64, 0x03],
  /** GS V B 0 — feed and partial cut. */
  cut: [0x1d, 0x56, 0x42, 0x00],
  /** ESC p m t1 t2 — pulse drawer pin 2 for 50 ms on / 500 ms off. */
  drawerKick: [0x1b, 0x70, 0x00, 0x19, 0xfa],
} as const;

export function ascii(s: string): string {
  return s.replace(/₹/g, "Rs.").normalize("NFKD").replace(/[^\x20-\x7e\n]/g, "");
}

const pad = (left: string, right: string, width: number) => {
  const l = ascii(left);
  const r = ascii(right);
  if (l.length + r.length + 1 > width) return `${l.slice(0, Math.max(0, width - r.length - 1))} ${r}`;
  return l + " ".repeat(width - l.length - r.length) + r;
};
const wrap = (s: string, width: number) => {
  const words = ascii(s).split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      if (line) out.push(line);
      line = w.slice(0, width);
    } else line = (line + " " + w).trim();
  }
  if (line) out.push(line);
  return out;
};

/** A document is a list of text lines with optional styling; `bytes()` turns it into ESC/POS. */
export type Doc = Array<{ text?: string; bold?: boolean; center?: boolean; big?: boolean; raw?: readonly number[] }>;

export function bytes(doc: Doc, opts: { cut?: boolean; kickDrawer?: boolean } = {}): Buffer {
  const out: number[] = [...ESC.init];
  for (const l of doc) {
    if (l.raw) {
      out.push(...l.raw);
      continue;
    }
    out.push(...(l.center ? ESC.center : ESC.left), ...(l.bold ? ESC.boldOn : ESC.boldOff), ...(l.big ? ESC.doubleOn : ESC.doubleOff));
    out.push(...Buffer.from(ascii(l.text ?? "") + "\n", "ascii"));
  }
  out.push(...ESC.boldOff, ...ESC.doubleOff, ...ESC.left);
  if (opts.kickDrawer) out.push(...ESC.drawerKick);
  if (opts.cut !== false) out.push(...ESC.feed3, ...ESC.cut);
  return Buffer.from(out);
}

/** Human-readable text of a document (stored on the PrintJob; shown for simulated prints). */
export function plain(doc: Doc): string {
  return doc.filter((l) => !l.raw).map((l) => ascii(l.text ?? "")).join("\n");
}

const rs = (v: string | number) => `Rs.${Number(v).toFixed(2)}`;

export function receiptDoc(bill: Bill, width: number, opts: { reprint?: boolean; timeLabel: string }): Doc {
  const rule = "-".repeat(width);
  const doc: Doc = [
    { text: bill.restaurant.name, bold: true, center: true, big: true },
    { text: bill.restaurant.outletName, center: true },
    ...(bill.restaurant.address ? wrap(bill.restaurant.address, width).map((t) => ({ text: t, center: true })) : []),
    ...(bill.restaurant.phone ? [{ text: `Ph ${bill.restaurant.phone}`, center: true }] : []),
    ...(bill.invoice?.sellerGstin ? [{ text: `GSTIN ${bill.invoice.sellerGstin}`, center: true }] : []),
    { text: rule },
    { text: pad(bill.kind === "RECEIPT" ? "RECEIPT" : "BILL", bill.billNo, width), bold: true },
    ...(bill.invoice ? [{ text: pad("Invoice", bill.invoice.number, width) }] : []),
    { text: pad(bill.table ? `Table ${bill.table}` : bill.channel, opts.timeLabel, width) },
    ...(opts.reprint ? [{ text: "*** REPRINT ***", center: true, bold: true }] : []),
    { text: rule },
  ];
  for (const l of bill.lines) {
    doc.push({ text: pad(`${Number(l.qty)} x ${l.name}`, rs(l.lineTotal), width) });
    for (const m of l.modifiers) doc.push({ text: `   + ${m.name}` });
    if (l.notes) for (const t of wrap(`   "${l.notes}"`, width)) doc.push({ text: t });
  }
  doc.push({ text: rule }, { text: pad("Subtotal", rs(bill.subtotal), width) });
  if (Number(bill.discount) > 0) doc.push({ text: pad("Discount", `-${rs(bill.discount)}`, width) });
  for (const t of bill.taxes) {
    const half = Number(t.amount) / 2;
    if (bill.invoice?.supplyType === "INTER_STATE") doc.push({ text: pad(`IGST ${Number(t.ratePct)}%`, rs(t.amount), width) });
    else doc.push({ text: pad(`CGST ${Number(t.ratePct) / 2}%`, rs(half), width) }, { text: pad(`SGST ${Number(t.ratePct) / 2}%`, rs(Number(t.amount) - half), width) });
  }
  doc.push({ text: pad("TOTAL", rs(bill.total), width), bold: true, big: false }, { text: rule });
  for (const p of bill.payments.filter((p) => p.status === "SUCCESS" || p.status === "PARTIAL" || p.status === "REFUNDED")) doc.push({ text: pad(`Paid ${p.method}`, rs(p.amount), width) });
  if (Number(bill.refunded) > 0) doc.push({ text: pad("Refunded", `-${rs(bill.refunded)}`, width) });
  if (Number(bill.balanceDue) > 0) doc.push({ text: pad("Balance due", rs(bill.balanceDue), width), bold: true });
  doc.push({ text: "" }, { text: "Thank you!", center: true });
  return doc;
}

export type KotData = { number: number; station: string | null; table: string | null; channel: string; orderRef: string; createdAt: string; items: Array<{ name: string; qty: string | number; modifiers: string[]; notes: string | null }> };

export function kotDoc(kot: KotData, width: number, opts: { reprint?: boolean }): Doc {
  const rule = "=".repeat(width);
  const doc: Doc = [
    { text: `KOT ${kot.number}`, bold: true, big: true, center: true },
    { text: kot.station ?? "KITCHEN", center: true },
    ...(opts.reprint ? [{ text: "*** REPRINT ***", center: true, bold: true }] : []),
    { text: pad(kot.table ? `Table ${kot.table}` : kot.channel, `#${kot.orderRef}`, width), bold: true },
    { text: kot.createdAt },
    { text: rule },
  ];
  for (const it of kot.items) {
    doc.push({ text: `${Number(it.qty)} x ${it.name}`, bold: true, big: true });
    for (const m of it.modifiers) doc.push({ text: `  + ${m}` });
    if (it.notes) for (const t of wrap(`  NOTE: ${it.notes}`, width)) doc.push({ text: t, bold: true });
  }
  doc.push({ text: rule });
  return doc;
}

export function testDoc(printerName: string, width: number, at: string): Doc {
  return [
    { text: "RESTORA printer test", bold: true, center: true },
    { text: ascii(printerName), center: true },
    { text: at, center: true },
    { text: "-".repeat(width) },
    { text: "0123456789".repeat(Math.ceil(width / 10)).slice(0, width) },
    { text: "If you can read this, printing works.", center: true },
  ];
}
