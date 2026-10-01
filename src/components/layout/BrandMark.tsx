/**
 * Aharos brand mark: a Moonstone rounded tile with a Vanilla accent arc — a
 * stylised plate/rising curve. Decorative; the wordmark carries the name.
 */
export function BrandMark({ className = "h-8 w-8", decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role={decorative ? "presentation" : "img"} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : "Aharos"} fill="none">
      <rect width="32" height="32" rx="9" fill="#357d90" />
      <rect width="32" height="32" rx="9" fill="url(#aharos-sheen)" fillOpacity="0.25" />
      {/* plate ring */}
      <circle cx="16" cy="16.5" r="7.5" stroke="#eff6f8" strokeWidth="2" strokeOpacity="0.85" />
      {/* vanilla rising arc */}
      <path d="M9.5 19.5c2.2-5 10.8-5 13 0" stroke="#ffebaf" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="12.6" r="1.8" fill="#ffebaf" />
      <defs>
        <linearGradient id="aharos-sheen" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
