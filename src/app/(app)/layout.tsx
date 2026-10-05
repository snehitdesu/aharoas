import { headers } from "next/headers";
import { prisma } from "@/server/db/client";
import { PATH_HEADER, safeReturnPath } from "@/constants/auth";
import { requireShell } from "@/lib/auth/shell";
import { unreadCount } from "@/server/services/notifications";
import { visibleNav } from "@/lib/nav";
import { AppShell } from "@/components/layout/AppShell";
import { ToastProvider } from "@/components/ui/Toast";
import { ReauthProvider } from "@/components/auth/ReauthProvider";

export const dynamic = "force-dynamic";

/** Authenticated back-office shell (server): session, outlets and permission-aware navigation. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Return path for an expired / revoked session (set by middleware, validated here).
  const { shell, ctx } = await requireShell(safeReturnPath((await headers()).get(PATH_HEADER)));
  const unread = await unreadCount(prisma, ctx).catch(() => null);
  return (
    <ToastProvider>
      <ReauthProvider>
      <AppShell shell={shell} nav={visibleNav(new Set(shell.permissions))} unread={unread}>
        {children}
      </AppShell>
      </ReauthProvider>
    </ToastProvider>
  );
}
