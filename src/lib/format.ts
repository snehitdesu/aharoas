/** Display formatting (pure, locale en-IN). */
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  return inr.format(Number.isFinite(n) ? n : 0);
}

export function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : value ?? 0;
  return Number.isFinite(n) ? n : 0;
}

/** "4m", "1h 05m" since `from`. */
export function formatElapsed(from: string | Date, now: number = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

export function minutesSince(from: string | Date, now: number = Date.now()): number {
  return Math.max(0, (now - new Date(from).getTime()) / 60000);
}

/** Short, human-friendly reference for a cuid (last 6 chars, upper-case). */
export function shortRef(id: string): string {
  return id.slice(-6).toUpperCase();
}

export function formatQty(q: number | string): string {
  const n = toNumber(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Like formatQty but keeps small quantities / factors (0.001, 0.0025) instead of rounding them to 0. */
export function formatPrecise(q: number | string, maxDigits = 6): string {
  const n = toNumber(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(maxDigits).replace(/0+$/, "").replace(/\.$/, "");
}

// ---------------- dates ----------------
// Timestamps are shown in the selected outlet's timezone (business context),
// falling back to the browser zone. Invalid / empty values render as "—".
function toDate(v: string | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(v: string | Date | null | undefined, timeZone?: string): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone }).format(d) : "—";
}

export function formatDateTime(v: string | Date | null | undefined, timeZone?: string): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d) : "—";
}

/** YYYY-MM-DD of `v` in `timeZone` (for date inputs / business-date filters). */
export function isoDay(v: Date = new Date(), timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(v);
}

export function formatPct(v: number | string | null | undefined, digits = 1): string {
  return `${toNumber(v).toFixed(digits)}%`;
}

/** "PURCHASE_RECEIPT" -> "Purchase receipt". */
export function humanize(v: string | null | undefined): string {
  if (!v) return "—";
  const s = v.replace(/[_.]+/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
