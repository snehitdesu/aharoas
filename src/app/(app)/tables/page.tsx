import { gated } from "@/lib/auth/gate";
import { TablesScreen } from "@/features/backoffice/tables";

export const dynamic = "force-dynamic";
export const metadata = { title: "Floors & tables — Aharos" };

export default function Page() {
  return gated("/tables", () => <TablesScreen />);
}
