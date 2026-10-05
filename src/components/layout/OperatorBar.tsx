import Link from "next/link";
import { OutletSwitcher } from "@/components/layout/OutletSwitcher";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { BrandMark, Wordmark } from "@/components/layout/BrandMark";
import { Icon } from "@/components/ui/Icon";
import type { ShellData } from "@/lib/auth/shell";

/** Compact operator header for full-screen POS and KDS: espresso chrome, terracotta rule, high contrast. */
export function OperatorBar({ shell, title, children }: { shell: ShellData; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b-[3px] border-brand-500 bg-espresso px-3 text-paper">
      <Link href="/dashboard" className="inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-vanilla-200" aria-label="RESTORA dashboard">
        <BrandMark className="h-6 w-6" decorative />
        <Wordmark tone="ivory" className="hidden text-[0.95rem] sm:inline" />
      </Link>
      <span aria-hidden className="hidden h-5 w-px bg-white/20 sm:block" />
      <h1 className="truncate font-display text-base font-semibold">{title}</h1>
      <OutletSwitcher outlets={shell.outlets} outletId={shell.outletId} dark />
      <div className="ml-auto flex items-center gap-2">
        {children}
        <span className="hidden text-sm text-white/70 md:inline">{shell.user.name}</span>
        <LogoutButton dark />
      </div>
    </header>
  );
}
