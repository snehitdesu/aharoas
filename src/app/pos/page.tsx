import { requireShell } from "@/lib/auth/shell";
import { OperatorBar } from "@/components/layout/OperatorBar";
import { ForbiddenPage } from "@/components/ui/States";
import { ToastProvider } from "@/components/ui/Toast";
import { PosScreen } from "@/features/pos/components/PosScreen";

export const dynamic = "force-dynamic";
export const metadata = { title: "POS — Aharos" };

export default async function PosPage() {
  const { shell } = await requireShell("/pos");
  const has = new Set(shell.permissions);
  return (
    <ToastProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-ink-100">
        <OperatorBar shell={shell} title="POS" />
        {!shell.outletId ? (
          <ForbiddenPage title="No outlet" reason="You don't have access to any active outlet." />
        ) : !has.has("order.create") ? (
          <ForbiddenPage title="POS not available" reason="Your role can't take orders at this outlet." />
        ) : (
          <PosScreen
            key={shell.outletId}
            outletId={shell.outletId}
            perms={{
              pay: has.has("payment.take"),
              discount: has.has("order.discount"),
              cancel: has.has("order.cancel"),
              customerView: has.has("customer.view"),
              customerManage: has.has("customer.manage"),
            }}
          />
        )}
      </div>
    </ToastProvider>
  );
}
