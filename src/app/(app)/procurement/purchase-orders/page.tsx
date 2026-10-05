import { gated } from "@/lib/auth/gate";
import { PurchaseOrdersScreen } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchase orders — RESTORA" };

export default function Page() {
  return gated("/procurement/purchase-orders", () => <PurchaseOrdersScreen />);
}
