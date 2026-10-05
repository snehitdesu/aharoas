import type { ReactNode } from "react";
import { BrandMark, Wordmark, TAGLINE } from "@/components/layout/BrandMark";
import { Icon } from "@/components/ui/Icon";

/** Shared control styles for the authentication forms (48 px, terracotta focus ring). */
export const authInput =
  "mt-1.5 block h-12 w-full rounded-lg border border-ink-300 bg-paper px-3.5 text-[15px] text-ink-900 placeholder:text-ink-400 transition-[border-color,box-shadow] duration-150 hover:border-ink-400 focus:border-brand-500 focus:outline-none focus:ring-[3px] focus:ring-brand-500/20 focus-visible:outline-none aria-[invalid=true]:border-bad-500 aria-[invalid=true]:focus:ring-bad-500/15";
export const authLabel = "block text-[13.5px] font-medium text-ink-700";

/**
 * Sign-in and password pages: a calm, centered workspace entrance. Warm paper
 * page, the RESTORA mark top-left, one compact panel with a hairline border —
 * the form is the only thing competing for attention. Short windows (the
 * 1024×700 desktop minimum) tighten the vertical rhythm so an error message
 * never pushes the page into scrolling. Used by /login,
 * /forgot-password, /set-password and /account/password.
 */
export function AuthShell({ title, subtitle, children, footer, help }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; help?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      {/* thin terracotta rule: the only colour accent on the page */}
      <div aria-hidden className="h-[3px] shrink-0 bg-brand-500" />
      <header className="flex shrink-0 items-center px-6 py-5 sm:px-10 [@media(max-height:760px)]:py-4">
        <div aria-label="RESTORA" role="img" className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8" decorative />
          <span className="leading-none">
            <Wordmark className="block text-[1.05rem]" />
            <span className="mt-1 block text-[11.5px] font-medium tracking-[0.01em] text-ink-500">{TAGLINE}</span>
          </span>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-8 pt-2 sm:pb-12 [@media(max-height:760px)]:pb-3 [@media(max-height:760px)]:pt-0">
        <div className="w-full max-w-[420px]">
          <div className="rounded-xl border border-ink-200 bg-paper px-6 py-8 shadow-[0_1px_2px_rgb(36_24_15/0.04),0_12px_32px_-16px_rgb(36_24_15/0.18)] sm:px-9 sm:py-9 [@media(max-height:760px)]:py-7">
            <h1 className="text-[2rem] font-semibold leading-[1.15] tracking-[-0.02em] text-ink-900">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-ink-500">{subtitle}</p>}
            <div className="mt-7 [@media(max-height:760px)]:mt-6">{children}</div>
          </div>
          {footer}
          <p className="mt-6 flex items-center [@media(max-height:760px)]:mt-4 justify-center gap-1.5 text-xs text-ink-500">
            <Icon name="shield" className="h-3.5 w-3.5 text-ink-400" />
            Secure restaurant workspace
          </p>
        </div>
      </main>
      <footer className="min-h-9 shrink-0 px-6 pb-5 text-center [@media(max-height:760px)]:pb-3 text-xs text-ink-500">{help}</footer>
    </div>
  );
}
