import { gated } from "@/lib/auth/gate";
import { StockScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock on hand — RESTORA" };

export default function Page() {
  return gated("/inventory", () => <StockScreen />);
}
