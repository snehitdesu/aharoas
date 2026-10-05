import { gated } from "@/lib/auth/gate";
import { TransfersScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock transfers — RESTORA" };

export default function Page() {
  return gated("/inventory/transfers", () => <TransfersScreen />);
}
