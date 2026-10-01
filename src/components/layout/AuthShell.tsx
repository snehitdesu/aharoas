import type { ReactNode } from "react";
import { BrandMark } from "@/components/layout/BrandMark";

/**
 * Shared chrome for sign-in and password pages. Establishes the Moonstone +
 * Vanilla identity without becoming a marketing landing page.
 */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-50 p-4">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-brand-100/70 blur-3xl" />
        <div className="absolute -bottom-28 -right-16 h-72 w-72 rounded-full bg-vanilla-200/50 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-600 via-brand-400 to-vanilla-300" />
      </div>
      <div className="relative w-full max-w-md">
        <div className="mb-5 flex items-center gap-3">
          <BrandMark className="h-10 w-10" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-700">Restaurant operating system</p>
        </div>
        <div className="rounded-xl border border-ink-200 bg-white p-6 shadow-raised">
          <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink-900">{title}</h1>
          {subtitle && <p className="mb-5 mt-1 text-sm text-ink-500">{subtitle}</p>}
          {!subtitle && <div className="mb-5" />}
          {children}
        </div>
        {footer}
      </div>
    </main>
  );
}
