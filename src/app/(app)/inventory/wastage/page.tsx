import { gated } from "@/lib/auth/gate";
import { WastageScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wastage — Aharos" };

export default function Page() {
  return gated("/inventory/wastage", () => <WastageScreen />);
}
