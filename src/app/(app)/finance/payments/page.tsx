import { gated } from "@/lib/auth/gate";
import { PaymentsScreen } from "@/features/backoffice/finance";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payments & refunds — Aharos" };

export default function Page() {
  return gated("/finance/payments", () => <PaymentsScreen />);
}
