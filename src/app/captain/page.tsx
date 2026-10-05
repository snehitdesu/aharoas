import { requireShell } from "@/lib/auth/shell";
import { ShellProvider } from "@/lib/shellContext";
import { OperatorBar } from "@/components/layout/OperatorBar";
import { ForbiddenPage } from "@/components/ui/States";
import { ToastProvider } from "@/components/ui/Toast";
import { ReauthProvider } from "@/components/auth/ReauthProvider";
import { CaptainApp } from "@/features/mobile/CaptainApp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Captain — RESTORA" };

/** Captain / waiter app (phone-first). The APIs re-check every permission. */
export default async function CaptainPage() {
  const { shell } = await requireShell("/captain");
  const has = new Set(shell.permissions);
  const outlet = shell.outlets.find((o) => o.id === shell.outletId);
  return (
    <ShellProvider shell={shell}>
      <ToastProvider>
        <ReauthProvider>
          <div className="flex h-[100dvh] flex-col overflow-hidden">
            <OperatorBar shell={shell} title="Captain" />
            {!outlet ? (
              <ForbiddenPage title="No outlet" reason="You don't have access to any active outlet." />
            ) : !has.has("order.view") || !has.has("order.create") ? (
              <ForbiddenPage title="Captain app not available" reason="Your role can't take table orders at this outlet." />
            ) : (
              <CaptainApp key={outlet.id} outletId={outlet.id} outletName={outlet.name} timeZone={outlet.timezone}
                perms={{ create: has.has("order.create"), modify: has.has("order.modify"), serve: has.has("kot.serve") || has.has("kot.update") }} />
            )}
          </div>
        </ReauthProvider>
      </ToastProvider>
    </ShellProvider>
  );
}
