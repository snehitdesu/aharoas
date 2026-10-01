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
    <nav aria-label="Main" className="flex flex-col gap-3">
      {groupNav(items).map((g) => (
        <div key={g.section ?? "_"} className="flex flex-col gap-0.5">
          {g.section && g.section !== "Operations" && <p className="px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{g.section}</p>}
          {g.items.map((item) => {
            const active = item.href === current;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                title={item.description}
                className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${active ? "bg-brand-50 font-medium text-brand-700" : "text-ink-700 hover:bg-ink-100"}`}
              >
                <Icon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
