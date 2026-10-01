import Link from "next/link";
import { OutletSwitcher } from "@/components/layout/OutletSwitcher";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { BrandMark } from "@/components/layout/BrandMark";
import { Icon } from "@/components/ui/Icon";
import type { ShellData } from "@/lib/auth/shell";

/** Compact operator header for full-screen POS and KDS. Moonstone identity, high contrast. */
export function OperatorBar({ shell, title, children }: { shell: ShellData; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-brand-800 bg-brand-900 px-3 text-white">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-white/85 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-vanilla-200">
        <BrandMark className="h-6 w-6" decorative />
        <span>Aharos</span>
      </Link>
      <span aria-hidden className="h-5 w-px bg-white/20" />
      <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
      <OutletSwitcher outlets={shell.outlets} outletId={shell.outletId} dark />
      <div className="ml-auto flex items-center gap-2">
        {children}
        <span className="hidden text-sm text-white/70 md:inline">{shell.user.name}</span>
        <LogoutButton dark />
      </div>
    </header>
  );
}
