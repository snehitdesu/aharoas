"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api/client";
import { Icon } from "@/components/ui/Icon";

export function LogoutButton({ dark = false }: { dark?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api("/api/auth/logout", { method: "POST" });
        } catch {
          /* the session is cleared server-side where possible; leave regardless */
        }
        router.replace("/login");
        router.refresh();
      }}
      className={`inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${dark ? "text-white/80 hover:bg-white/10" : "text-ink-700 hover:bg-ink-100"}`}
    >
      <Icon name="logout" /> <span className="sr-only sm:not-sr-only">{busy ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}
