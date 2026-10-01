import { gated } from "@/lib/auth/gate";
import { AnomaliesScreen } from "@/features/backoffice/alerts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Anomalies — Aharos" };

export default function Page() {
  return gated("/anomalies", () => <AnomaliesScreen />);
}
