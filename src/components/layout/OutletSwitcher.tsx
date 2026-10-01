"use client";

import { useRouter } from "next/navigation";
import { OUTLET_COOKIE } from "@/constants/auth";
import type { ShellOutlet } from "@/lib/auth/shell";

/** Stores the chosen outlet as a UI preference; the server re-validates it against the user's access. */
export function OutletSwitcher({ outlets, outletId, dark = false }: { outlets: ShellOutlet[]; outletId: string | null; dark?: boolean }) {
  const router = useRouter();
  if (outlets.length === 0) return <span className="text-sm text-ink-500">No outlet access</span>;
  if (outlets.length === 1) return <span className={`text-sm font-medium ${dark ? "text-white" : "text-ink-900"}`}>{outlets[0].name}</span>;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Outlet</span>
      <select
        value={outletId ?? ""}
        onChange={(e) => {
          document.cookie = `${OUTLET_COOKIE}=${encodeURIComponent(e.target.value)}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
        className={`h-9 rounded-md border px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${dark ? "border-white/20 bg-ink-900 text-white" : "border-ink-300 bg-white text-ink-900"}`}
      >
        {outlets.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.code})
          </option>
        ))}
      </select>
    </label>
  );
}
