import { gated } from "@/lib/auth/gate";
import { OutletsScreen } from "@/features/backoffice/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Outlets — RESTORA" };

export default function Page() {
  return gated("/settings/outlets", () => <OutletsScreen />);
}
