"use client";

/**
 * Client view of the operator shell: selected outlet, accessible outlets and the
 * permissions held there. Used ONLY to hide actions the user cannot perform —
 * every API call is still authorized server-side.
 */
import { createContext, useContext, useMemo } from "react";
import type { ShellData, ShellOutlet } from "@/lib/auth/shell";
import type { Permission } from "@/server/auth/rbac";

export type ShellCtx = {
  user: ShellData["user"];
  outlets: ShellOutlet[];
  outletId: string | null;
  outlet: ShellOutlet | null;
  orgWide: boolean;
  can: (p: Permission) => boolean;
};

const Ctx = createContext<ShellCtx | null>(null);

export function ShellProvider({ shell, children }: { shell: ShellData; children: React.ReactNode }) {
  const value = useMemo<ShellCtx>(() => {
    const perms = new Set<string>(shell.permissions);
    return {
      user: shell.user,
      outlets: shell.outlets,
      outletId: shell.outletId,
      outlet: shell.outlets.find((o) => o.id === shell.outletId) ?? null,
      orgWide: shell.orgWide,
      can: (p) => perms.has(p),
    };
  }, [shell]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShell(): ShellCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShell must be used inside <ShellProvider>");
  return v;
}

/** The selected outlet id; back-office screens render only when one exists (see AppShell). */
export function useOutletId(): string {
  const { outletId } = useShell();
  if (!outletId) throw new Error("No outlet selected");
  return outletId;
}
