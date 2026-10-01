"use client";

import { useState } from "react";
import Link from "next/link";
import { SideNav } from "@/components/layout/SideNav";
import { OutletSwitcher } from "@/components/layout/OutletSwitcher";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { Icon } from "@/components/ui/Icon";
import type { NavItem } from "@/lib/nav";
import type { ShellData } from "@/lib/auth/shell";
import { ShellProvider } from "@/lib/shellContext";

/**
 * Back-office shell: sidebar (collapsible on tablet/mobile), top bar with outlet
 * + user. Provides the shell context (UI hints only) and remounts the page when
 * the outlet changes so no screen keeps another outlet's state.
 */
export function AppShell({ shell, nav, unread, children }: { shell: ShellData; nav: NavItem[]; unread: number | null; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className={`fixed inset-y-0 left-0 z-40 w-60 overflow-y-auto border-r border-ink-300 bg-white p-3 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="mb-4 flex items-center justify-between px-2">
          <span className="text-lg font-semibold tracking-tight text-ink-900">Aharos</span>
          <button type="button" className="rounded p-1 lg:hidden" onClick={() => setOpen(false)} aria-label="Close navigation">
            <Icon name="x" />
          </button>
        </div>
        <SideNav items={nav} onNavigate={() => setOpen(false)} />
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-ink-900/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-ink-300 bg-white px-4">
          <button type="button" className="rounded p-1.5 hover:bg-ink-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Icon name="menu" className="h-5 w-5" />
          </button>
          <OutletSwitcher outlets={shell.outlets} outletId={shell.outletId} />
          <div className="ml-auto flex items-center gap-3">
            {unread !== null && (
              <Link href="/notifications" className="relative inline-flex items-center rounded p-1 text-ink-700 hover:bg-ink-100" aria-label={`${unread} unread notifications`}>
                <Icon name="bell" className="h-5 w-5" />
                {unread > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-bad-500 px-1 text-center text-[10px] font-semibold leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
              </Link>
            )}
            <span className="hidden text-right text-sm leading-tight sm:block">
              <span className="block font-medium text-ink-900">{shell.user.name}</span>
              <span className="block text-xs text-ink-500">{shell.roles.join(", ").toLowerCase()}</span>
            </span>
            <LogoutButton />
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">
          <ShellProvider shell={shell}>
            {shell.outletId ? (
              <div key={shell.outletId}>{children}</div>
            ) : (
              <p className="text-sm text-ink-500">You don&apos;t have access to any active outlet yet. Ask a manager to add you to an outlet.</p>
            )}
          </ShellProvider>
        </main>
      </div>
    </div>
  );
}
