import { gated } from "@/lib/auth/gate";
import { GRNsScreen } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Goods receipts — Aharos" };

export default function Page() {
  return gated("/procurement/grns", () => <GRNsScreen />);
}
