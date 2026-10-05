import { gated } from "@/lib/auth/gate";
import { WastageScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wastage — RESTORA" };

export default function Page() {
  return gated("/inventory/wastage", () => <WastageScreen />);
}
