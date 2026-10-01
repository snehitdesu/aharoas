import { gated } from "@/lib/auth/gate";
import { StockCountsScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock counts — Aharos" };

export default function Page() {
  return gated("/inventory/counts", () => <StockCountsScreen />);
}
