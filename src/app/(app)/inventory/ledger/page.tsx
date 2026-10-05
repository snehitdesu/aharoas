import { gated } from "@/lib/auth/gate";
import { LedgerScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inventory ledger — RESTORA" };

export default function Page() {
  return gated("/inventory/ledger", () => <LedgerScreen />);
}
