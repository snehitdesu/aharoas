import { requireShell } from "@/lib/auth/shell";
import { OperatorBar } from "@/components/layout/OperatorBar";
import { ForbiddenPage } from "@/components/ui/States";
import { ToastProvider } from "@/components/ui/Toast";
import { KitchenScreen } from "@/features/kitchen/components/KitchenScreen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kitchen — Aharos" };

export default async function KitchenPage() {
  const { shell } = await requireShell("/kitchen");
  const has = new Set(shell.permissions);
  return (
    <ToastProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-ink-100">
        <OperatorBar shell={shell} title="Kitchen display" />
        {!shell.outletId ? (
          <ForbiddenPage title="No outlet" reason="You don't have access to any active outlet." />
        ) : !has.has("kot.view") ? (
          <ForbiddenPage title="Kitchen display not available" reason="Your role can't view kitchen tickets at this outlet." />
        ) : (
          <KitchenScreen key={shell.outletId} outletId={shell.outletId} canUpdate={has.has("kot.update")} />
        )}
      </div>
    </ToastProvider>
  );
}
