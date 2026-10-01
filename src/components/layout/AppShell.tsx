"use client";

import { useState } from "react";
import Link from "next/link";
import { SideNav } from "@/components/layout/SideNav";
import { OutletSwitcher } from "@/components/layout/OutletSwitcher";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { Icon } from "@/components/ui/Icon";
import { BrandMark } from "@/components/layout/BrandMark";
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
    <div className="flex min-h-screen bg-ink-50">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:shadow-pop">
        Skip to content
      </a>
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-ink-200 bg-white transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-ink-100 px-4">
          <Link href="/dashboard" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-md outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
            <BrandMark className="h-8 w-8" decorative />
            <span className="text-[1.05rem] font-semibold tracking-[-0.02em] text-ink-900">Aharos</span>
          </Link>
          <button type="button" className="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 lg:hidden" onClick={() => setOpen(false)} aria-label="Close navigation">
            <Icon name="x" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SideNav items={nav} onNavigate={() => setOpen(false)} />
        </div>
        <div className="shrink-0 border-t border-ink-100 px-4 py-2.5">
          <p className="truncate text-[11px] text-ink-400">Operational intelligence for restaurants</p>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-ink-900/40 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-ink-200 bg-white/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80 lg:px-6">
          <button type="button" className="rounded-md p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Icon name="menu" className="h-5 w-5" />
          </button>
          <OutletSwitcher outlets={shell.outlets} outletId={shell.outletId} />
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
            {unread !== null && (
              <Link href="/notifications" className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900" aria-label={`${unread} unread notifications`}>
                <Icon name="bell" className="h-5 w-5" />
                {unread > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-bad-500 px-1 text-center text-[10px] font-semibold leading-4 text-white ring-2 ring-white">{unread > 99 ? "99+" : unread}</span>}
              </Link>
            )}
            <div className="hidden items-center gap-2.5 border-l border-ink-200 pl-2.5 sm:flex">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold uppercase text-brand-700" aria-hidden>
                {initials(shell.user.name)}
              </span>
              <span className="text-right text-sm leading-tight">
                <span className="block font-medium text-ink-900">{shell.user.name}</span>
                <span className="block text-xs capitalize text-ink-500">{shell.roles.join(", ").toLowerCase()}</span>
              </span>
            </div>
            <Link href="/account/password" aria-label="Password" className="inline-flex h-9 items-center rounded-md px-2.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500" title="Account & password">
              <Icon name="shield" className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Password</span>
            </Link>
            <LogoutButton />
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">
          <ShellProvider shell={shell}>
            {shell.outletId ? (
              <div key={shell.outletId} className="animate-fade-in">{children}</div>
            ) : (
              <div className="mx-auto mt-10 max-w-md rounded-xl border border-ink-200 bg-white p-6 text-center shadow-card">
                <span className="mx-auto mb-2 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-vanilla-100 text-vanilla-700"><Icon name="store" className="h-5 w-5" /></span>
                <p className="text-sm font-semibold text-ink-800">No outlet assigned yet</p>
                <p className="mt-1 text-sm text-ink-500">You don&apos;t have access to any active outlet. Ask a manager to add you to an outlet.</p>
              </div>
            )}
          </ShellProvider>
        </main>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "–";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
