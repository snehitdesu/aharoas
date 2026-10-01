import { gated } from "@/lib/auth/gate";
import { UnitsScreen } from "@/features/backoffice/master";

export const dynamic = "force-dynamic";
export const metadata = { title: "Units — Aharos" };

export default function Page() {
  return gated("/master/units", () => <UnitsScreen />);
}
