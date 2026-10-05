import { gated } from "@/lib/auth/gate";
import { BillsScreen } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchase bills — RESTORA" };

export default function Page() {
  return gated("/procurement/bills", () => <BillsScreen />);
}
