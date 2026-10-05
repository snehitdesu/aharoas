import { gated } from "@/lib/auth/gate";
import { AnalyticsScreen } from "@/features/backoffice/analytics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics — RESTORA" };

export default function Page() {
  return gated("/analytics", () => <AnalyticsScreen />);
}
