/** Inline stroke icons for the guest storefront (decorative: aria-hidden; the control carries the label). */
const PATHS = {
  cart: "M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.1L21 8H6.2M9 20.5h.01M17 20.5h.01",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 3-4.3-4.3",
  x: "M6 6l12 12M18 6 6 18",
  back: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  arrow: "M5 12h14M13 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4.5l3 2",
  pin: "M12 21s-7-6.2-7-11.5a7 7 0 1 1 14 0C19 14.8 12 21 12 21Zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  phone: "M5 4h3.5l1.6 4.2-2.2 1.4a11 11 0 0 0 6.5 6.5l1.4-2.2L20 15.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6M9 16h3",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5v-5m0-3h.01",
  alert: "M12 3 2.5 20h19L12 3Zm0 6v5m0 3h.01",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8",
  bag: "M5 8h14l-1 12H6L5 8Zm4 0V6a3 3 0 0 1 6 0v2",
  smile: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01",
  cash: "M3 6h18v12H3V6Zm9 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v.01M18 15v.01",
  card: "M3 6h18v12H3V6Zm0 4h18M7 15h4",
  offline: "M2 8.5a15 15 0 0 1 4-2.4m4-.9A15 15 0 0 1 22 8.5M5.5 12a10 10 0 0 1 3.4-2M13 9.2a10 10 0 0 1 5.5 2.8M9 15.5a5 5 0 0 1 6 0M12 19h.01M3 3l18 18",
  leaf: "M5 19c0-8 5-13 14-14-1 9-6 14-14 14Zm0 0 7-7",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  edit: "M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  chef: "M7 10a4 4 0 1 1 3-6.6A4 4 0 1 1 17 10v4H7v-4Zm0 7h10v3H7v-3Z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4h4",
  qr: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2v2h-2v-2Zm4 0h2v2h-2zm-4 4h2v2h-2zm4 0h2v2h-2z",
} as const;

export type SfIconName = keyof typeof PATHS;

export function SfIcon({ name, className, strokeWidth = 2 }: { name: SfIconName; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      <path d={PATHS[name]} />
    </svg>
  );
}
