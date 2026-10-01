"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { groupNav, navFor, type NavItem } from "@/lib/nav";

/** Grouped, permission-filtered navigation; the most specific matching entry is current. */
export function SideNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const current = navFor(pathname, items)?.href;
  return (
    <nav aria-label="Main" className="flex flex-col gap-4">
      {groupNav(items).map((g) => (
        <div key={g.section ?? "_"} className="flex flex-col gap-0.5">
          {g.section && <p className="px-3 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-400">{g.section}</p>}
          {g.items.map((item) => {
            const active = item.href === current;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                title={item.description}
                className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[0.8125rem] font-medium outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 ${
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"
                }`}
              >
                {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-brand-500" />}
                <Icon name={item.icon} className={`h-[1.05rem] w-[1.05rem] shrink-0 ${active ? "text-brand-600" : "text-ink-400 group-hover:text-ink-600"}`} />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
