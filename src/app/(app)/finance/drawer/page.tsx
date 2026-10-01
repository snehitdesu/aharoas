import { gated } from "@/lib/auth/gate";
import { DrawerScreen } from "@/features/backoffice/finance";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cash drawer — Aharos" };

export default function Page() {
  return gated("/finance/drawer", () => <DrawerScreen />);
}
