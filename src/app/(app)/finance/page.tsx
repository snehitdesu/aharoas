import { gated } from "@/lib/auth/gate";
import { FinanceOverviewScreen } from "@/features/backoffice/finance";

export const dynamic = "force-dynamic";
export const metadata = { title: "Finance — Aharos" };

export default function Page() {
  return gated("/finance", () => <FinanceOverviewScreen />);
}
