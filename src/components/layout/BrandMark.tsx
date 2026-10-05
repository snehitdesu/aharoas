/**
 * RESTORA brand mark: an espresso tile with a terracotta sun rising over
 * three ivory "table" stripes — a retro, printed-poster motif that stays
 * legible at 16 px. Decorative next to the wordmark; otherwise labelled.
 */
export function BrandMark({ className = "h-8 w-8", decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role={decorative ? "presentation" : "img"} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : "RESTORA"} fill="none">
      <rect width="32" height="32" rx="7" fill="#24180f" />
      {/* rising sun */}
      <path d="M7 19.5a9 9 0 0 1 18 0Z" fill="#c85a35" />
      <circle cx="16" cy="19.5" r="3.4" fill="#f6dfa3" />
      {/* stripes */}
      <rect x="5" y="21" width="22" height="1.8" rx=".9" fill="#fffcf6" />
      <rect x="7.5" y="24.2" width="17" height="1.8" rx=".9" fill="#fffcf6" fillOpacity=".8" />
      <rect x="10" y="27.4" width="12" height="1.8" rx=".9" fill="#fffcf6" fillOpacity=".6" />
    </svg>
  );
}

/** The RESTORA wordmark (display serif, spaced capitals). `tone` picks ink on paper or ivory on espresso. */
export function Wordmark({ className = "", tone = "ink" }: { className?: string; tone?: "ink" | "ivory" }) {
  return <span className={`font-display font-bold tracking-[0.12em] ${tone === "ivory" ? "text-paper" : "text-ink-900"} ${className}`}>RESTORA</span>;
}

export const TAGLINE = "The Operating System for Restaurants";
