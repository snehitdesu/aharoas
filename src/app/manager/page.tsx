import { requireShell } from "@/lib/auth/shell";
import { ShellProvider } from "@/lib/shellContext";
import { OperatorBar } from "@/components/layout/OperatorBar";
import { ForbiddenPage } from "@/components/ui/States";
import { ToastProvider } from "@/components/ui/Toast";
import { ReauthProvider } from "@/components/auth/ReauthProvider";
import { ManagerApp } from "@/features/mobile/ManagerApp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manager — RESTORA" };

/** Owner / manager app (phone-first). Sections follow the role; the API re-checks every permission. */
export default async function ManagerPage() {
  const { shell } = await requireShell("/manager");
  const has = new Set(shell.permissions);
  const outlet = shell.outlets.find((o) => o.id === shell.outletId);
  const allowed = ["reports.view", "finance.view", "inventory.view", "order.view"].some((p) => has.has(p as never));
  return (
    <ShellProvider shell={shell}>
      <ToastProvider>
        <ReauthProvider>
          <div className="flex h-[100dvh] flex-col overflow-hidden">
            <OperatorBar shell={shell} title="Manager" />
            {!outlet ? (
              <ForbiddenPage title="No outlet" reason="You don't have access to any active outlet." />
            ) : !allowed || !has.has("reports.view") && !has.has("finance.view") ? (
              <ForbiddenPage title="Manager app not available" reason="Your role doesn't include management views at this outlet." />
            ) : (
              <ManagerApp key={outlet.id} outletId={outlet.id} outletName={outlet.name}
                perms={{ staff: has.has("staff.manage"), captain: has.has("order.create"), pos: has.has("order.create"), kitchen: has.has("kot.view") }} />
            )}
          </div>
        </ReauthProvider>
      </ToastProvider>
    </ShellProvider>
  );
}
