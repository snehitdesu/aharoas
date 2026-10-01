"use client";

import { useRouter } from "next/navigation";
import { OUTLET_COOKIE } from "@/constants/auth";
import { Icon } from "@/components/ui/Icon";
import type { ShellOutlet } from "@/lib/auth/shell";

/** Stores the chosen outlet as a UI preference; the server re-validates it against the user's access. */
export function OutletSwitcher({ outlets, outletId, dark = false }: { outlets: ShellOutlet[]; outletId: string | null; dark?: boolean }) {
  const router = useRouter();
  if (outlets.length === 0) return <span className="text-sm text-ink-500">No outlet access</span>;
  if (outlets.length === 1) {
    return (
      <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${dark ? "text-white" : "text-ink-900"}`}>
        <Icon name="store" className={`h-4 w-4 ${dark ? "text-white/60" : "text-ink-400"}`} /> {outlets[0].name}
      </span>
    );
  }
  return (
    <label className={`flex items-center gap-1.5 rounded-md border pl-2.5 text-sm transition-colors ${dark ? "border-white/20 bg-white/5 focus-within:border-white/40" : "border-ink-300 bg-white hover:border-ink-400 focus-within:border-brand-400"}`}>
      <Icon name="store" className={`h-4 w-4 ${dark ? "text-white/60" : "text-ink-400"}`} />
      <span className="sr-only">Outlet</span>
      <select
        value={outletId ?? ""}
        onChange={(e) => {
          document.cookie = `${OUTLET_COOKIE}=${encodeURIComponent(e.target.value)}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
        className={`h-9 cursor-pointer appearance-none rounded-md bg-transparent pr-7 text-sm font-medium outline-none ${dark ? "text-white [&>option]:text-ink-900" : "text-ink-900"}`}
        style={{ backgroundImage: "none" }}
      >
        {outlets.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.code})
          </option>
        ))}
      </select>
      <Icon name="chevronDown" className={`pointer-events-none -ml-6 h-4 w-4 ${dark ? "text-white/60" : "text-ink-400"}`} />
    </label>
  );
}
