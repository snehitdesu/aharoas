import { gated } from "@/lib/auth/gate";
import { ReportsScreen } from "@/features/backoffice/reports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports — RESTORA" };

export default function Page() {
  return gated("/reports", () => <ReportsScreen />);
}
