/** Minimal inline icon set (stroke icons, currentColor). Decorative unless `label` is given. */
const PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  pos: "M4 5h16v10H4zM8 19h8M12 15v4",
  kitchen: "M6 3v8M9 3v8M6 7h3M7.5 11v10M16 3c-1.7 0-3 2-3 5s1 4 3 4v9",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  x: "M6 6l12 12M18 6 6 18",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  logout: "M15 17l5-5-5-5M20 12H9M12 21H5V3h7",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  table: "M4 8h16M6 8v11M18 8v11M4 5h16",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  check: "M5 13l4 4L19 7",
  alert: "M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  menu: "M4 6h16M4 12h16M4 18h16",
  cash: "M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  note: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  chevronDown: "M6 9l6 6 6-6",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  menuBook: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7M8 11h7",
  tag: "M3 12V4h8l9 9-8 8zM7.5 7.5h.01",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  flask: "M9 3h6M10 3v6L4 19a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 19L14 9V3M7 14h10",
  box: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  swap: "M7 7h13l-4-4M17 17H4l4 4",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  clipboard: "M9 4h6v3H9zM7 5H5v16h14V5h-2M8 12h8M8 16h5",
  factory: "M3 21V10l6 4V10l6 4V6l6 3v12zM3 21h18",
  cart: "M3 4h2l2.4 11h11L21 7H6M9 20h.01M18 20h.01",
  inbox: "M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  leaf: "M5 19c0-8 6-14 15-14 0 9-6 15-14 15zM5 19l7-7",
  truck: "M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  ruler: "M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-5-6.7",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  card: "M3 6h18v12H3zM3 10h18M7 15h3",
  wallet: "M4 6h15v12H4zM4 6l12-3v3M15 12h.01",
  scale: "M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  building: "M5 21V3h10v18M15 9h4v12M9 7h2M9 11h2M9 15h2M3 21h18",
  store: "M4 9l1-5h14l1 5M4 9v11h16V9M4 9h16M9 20v-6h6v6",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  edit: "M4 20h4L20 8l-4-4L4 16zM14 6l4 4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "h-4 w-4", label }: { name: IconName; className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}>
      <path d={PATHS[name]} />
    </svg>
  );
}
