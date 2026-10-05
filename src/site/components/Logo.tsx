/**
 * RESTORA identity: a geometric R monogram closed by a terracotta full stop,
 * the same stop the website sets after its headlines ("for restaurants.").
 * Built only from a rectangle, an arc stroke, a parallelogram and a circle on a
 * 32 px grid, so it stays crisp at 16 px and rasterizes without a font.
 *
 * Tones: "espresso" (espresso tile, ivory R) for light grounds, "ivory" (ivory
 * tile, espresso R) for dark grounds, "mono" (no tile, currentColor) for
 * single-colour use.
 */
type Tone = "espresso" | "ivory" | "mono";

const TONES: Record<Exclude<Tone, "mono">, { tile: string; glyph: string }> = {
  espresso: { tile: "#24180f", glyph: "#fffcf6" },
  ivory: { tile: "#f7f1e6", glyph: "#24180f" },
};
const STOP = "#d0613b";

export function RestoraMark({ tone = "espresso", className = "h-8 w-8", title }: { tone?: Tone; className?: string; title?: string }) {
  const t = tone === "mono" ? null : TONES[tone];
  const glyph = t ? t.glyph : "currentColor";
  return (
    <svg viewBox="0 0 32 32" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      {t && <rect width="32" height="32" rx="7.5" fill={t.tile} />}
      <rect x="5.7" y="7.5" width="4.2" height="17" fill={glyph} />
      <path d="M7.7 9.6h5.6a4.6 4.6 0 0 1 0 9.2H7.7" fill="none" stroke={glyph} strokeWidth="4.2" />
      <path d="M11.9 18.2h4.4l4 6.3h-4.4z" fill={glyph} />
      <circle cx="24" cy="22.3" r="2.25" fill={tone === "mono" ? "currentColor" : STOP} />
    </svg>
  );
}

/** Mark + wordmark lockup. The wordmark is the display serif in spaced capitals. */
export function RestoraLogo({ tone = "espresso", className = "", size = "md" }: { tone?: Exclude<Tone, "mono">; className?: string; size?: "md" | "lg" }) {
  return (
    <span className={`s-logo ${size === "lg" ? "s-logo-lg" : ""} ${tone === "ivory" ? "s-logo-on-dark" : ""} ${className}`}>
      <RestoraMark tone={tone} className="s-logo-mark" />
      <span className="s-logo-word">RESTORA</span>
    </span>
  );
}
