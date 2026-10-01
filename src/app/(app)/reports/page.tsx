import { gated } from "@/lib/auth/gate";
import { ReportsScreen } from "@/features/backoffice/reports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports — Aharos" };

export default function Page() {
  return gated("/reports", () => <ReportsScreen />);
}
