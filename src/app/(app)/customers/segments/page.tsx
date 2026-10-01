import { gated } from "@/lib/auth/gate";
import { SegmentsScreen } from "@/features/backoffice/crm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer segments — Aharos" };

export default function Page() {
  return gated("/customers/segments", () => <SegmentsScreen />);
}
