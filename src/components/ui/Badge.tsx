type Tone = "neutral" | "info" | "ok" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700 border-ink-300",
  info: "bg-brand-50 text-brand-700 border-brand-100",
  ok: "bg-ok-100 text-green-800 border-green-200",
  warn: "bg-warn-100 text-amber-800 border-amber-200",
  bad: "bg-bad-100 text-red-800 border-red-200",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}>{children}</span>;
}
