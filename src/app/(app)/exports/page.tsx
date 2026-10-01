import { gated } from "@/lib/auth/gate";
import { ExportsScreen } from "@/features/backoffice/reports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exports — Aharos" };

export default function Page() {
  return gated("/exports", () => <ExportsScreen />);
}
