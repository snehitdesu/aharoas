/**
 * Business-day / timezone utilities (pure; uses the platform's IANA tz data via
 * Intl — no dependency). Every outlet has an IANA `timezone` (Outlet.timezone);
 * a "business date" is a calendar date in that timezone.
 *
 * Conventions:
 *  - Timestamps are always stored as UTC instants and are never rewritten.
 *  - A business date is represented as "YYYY-MM-DD".
 *  - `businessDayRange(date, tz)` = [start, end) UTC instants of that local day
 *    (correct across DST: start/end are resolved independently).
 *  - `businessDateKey(date)` = UTC midnight of the calendar date: the canonical
 *    DateTime stored in date-keyed rows (e.g. Reconciliation.businessDate).
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Throws RangeError for an unknown IANA zone. */
export function assertTimeZone(tz: string): string {
  formatter(tz);
  return tz;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    assertTimeZone(tz);
    return true;
  } catch {
    return false;
  }
}

function parts(instant: Date, tz: string) {
  const p = Object.fromEntries(formatter(tz).formatToParts(instant).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset of `tz` from UTC at `instant`, in minutes (e.g. Asia/Kolkata = +330). */
export function utcOffsetMinutes(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Calendar date ("YYYY-MM-DD") of `instant` in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** UTC instant of local wall-clock midnight of `date` in `tz`. */
function localMidnight(date: string, tz: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid business date "${date}" (expected YYYY-MM-DD)`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  // Two passes handle DST transitions around midnight.
  let t = guess - utcOffsetMinutes(new Date(guess), tz) * 60000;
  t = guess - utcOffsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

function nextDate(date: string): string {
  const m = DATE_RE.exec(date)!;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a business-date input to "YYYY-MM-DD" in `tz`:
 *  - "YYYY-MM-DD" strings are taken literally (the calendar date the user meant);
 *  - Date instants (e.g. `new Date()` = "now") map to their local date in `tz`.
 */
export function toBusinessDate(input: Date | string, tz: string): string {
  if (typeof input === "string") {
    if (DATE_RE.test(input)) return input;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid business date "${input}"`);
    return localDate(d, tz);
  }
  return localDate(input, tz);
}

/** [start, end) UTC instants of a business day in `tz`. */
export function businessDayRange(input: Date | string, tz: string): { date: string; start: Date; end: Date } {
  const date = toBusinessDate(input, tz);
  return { date, start: localMidnight(date, tz), end: localMidnight(nextDate(date), tz) };
}

/** Canonical DateTime key for a business date (UTC midnight of that calendar date). */
export function businessDateKey(input: Date | string, tz: string): Date {
  const date = toBusinessDate(input, tz);
  return new Date(`${date}T00:00:00.000Z`);
}
