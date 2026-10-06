/**
 * Outlet opening hours (Outlet.openTime / closeTime, "HH:mm" in the outlet's
 * timezone). Pure functions shared by the guest storefront and its server.
 *
 *  - Hours are optional: an outlet without both times is treated as open
 *    (ordering is never blocked by data the owner has not entered).
 *  - open == close means open around the clock.
 *  - close < open is an overnight window (e.g. 18:00–02:00).
 */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type OutletHours = { openTime: string | null; closeTime: string | null; timezone: string };

/** Minutes after midnight for "HH:mm", or null when the value is missing / malformed. */
export function minutesOf(hhmm: string | null | undefined): number | null {
  const m = typeof hhmm === "string" ? HHMM.exec(hhmm.trim()) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after midnight of `now` on the outlet's wall clock. */
export function localMinutes(now: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** Whether both opening times are set (and valid). */
export function hasHours(h: Pick<OutletHours, "openTime" | "closeTime">): boolean {
  return minutesOf(h.openTime) !== null && minutesOf(h.closeTime) !== null;
}

/** Open at `now`? Outlets without configured hours are always open. */
export function isOpenAt(h: OutletHours, now: Date = new Date()): boolean {
  const open = minutesOf(h.openTime);
  const close = minutesOf(h.closeTime);
  if (open === null || close === null || open === close) return true;
  const m = localMinutes(now, h.timezone);
  return open < close ? m >= open && m < close : m >= open || m < close;
}

/** "9:00 AM" style label for "HH:mm" (null when not set). */
export function formatClock(hhmm: string | null | undefined): string | null {
  const mins = minutesOf(hhmm);
  if (mins === null) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "9:00 AM – 11:30 PM", "Open 24 hours", or null when hours are not configured. */
export function formatHours(h: Pick<OutletHours, "openTime" | "closeTime">): string | null {
  if (!hasHours(h)) return null;
  if (minutesOf(h.openTime) === minutesOf(h.closeTime)) return "Open 24 hours";
  return `${formatClock(h.openTime)} – ${formatClock(h.closeTime)}`;
}
