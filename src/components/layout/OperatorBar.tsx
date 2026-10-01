import Link from "next/link";
import { OutletSwitcher } from "@/components/layout/OutletSwitcher";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { Icon } from "@/components/ui/Icon";
import type { ShellData } from "@/lib/auth/shell";

/** Compact dark top bar for full-screen operator surfaces (POS, KDS). */
export function OperatorBar({ shell, title, children }: { shell: ShellData; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 bg-ink-900 px-3 text-white">
      <Link href="/dashboard" className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-white/80 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
        <Icon name="chevronLeft" /> Aharos
      </Link>
      <h1 className="text-sm font-semibold">{title}</h1>
      <OutletSwitcher outlets={shell.outlets} outletId={shell.outletId} dark />
      <div className="ml-auto flex items-center gap-2">
        {children}
        <span className="hidden text-sm text-white/70 md:inline">{shell.user.name}</span>
        <LogoutButton dark />
      </div>
    </header>
  );
}
