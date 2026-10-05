type Tone = "neutral" | "info" | "brand" | "accent" | "ok" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700 border-ink-200",
  info: "bg-info-50 text-info-700 border-info-100",
  brand: "bg-brand-50 text-brand-700 border-brand-100",
  accent: "bg-vanilla-100 text-vanilla-700 border-vanilla-200",
  ok: "bg-ok-50 text-ok-700 border-ok-100",
  warn: "bg-warn-50 text-warn-700 border-warn-100",
  bad: "bg-bad-50 text-bad-700 border-bad-100",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tracking-[0.01em] ${TONES[tone]} ${className}`}>{children}</span>;
}
