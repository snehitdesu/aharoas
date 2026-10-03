"use client";

import { ApiError, describeError } from "@/lib/api/client";
import { PASSWORD_MIN_LENGTH } from "@/constants/password";

export const inputClass =
  "mt-1 h-10 w-full rounded-md border border-ink-300 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500";

export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number or symbol. Avoid your name or email.`;

export function PasswordInput({ id, label, value, onChange, autoComplete, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">{label}</label>
      <input id={id} name={id} type="password" autoComplete={autoComplete} required value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} className={inputClass} />
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function FormAlert({ tone = "error", children }: { tone?: "error" | "success"; children: React.ReactNode }) {
  const cls = tone === "error" ? "border-bad-100 bg-bad-50 text-bad-700" : "border-ok-100 bg-ok-50 text-ok-700";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  );
}

/** Policy problems come back as details.fieldErrors; show all of them, not just the first. */
export function passwordErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.kind === "validation") {
    const fe = (err.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined)?.fieldErrors;
    const all = Object.values(fe ?? {}).flatMap((v) => v ?? []);
    if (all.length) return [...new Set(all)].join(". ");
  }
  return describeError(err);
}
