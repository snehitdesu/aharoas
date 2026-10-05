import { gated } from "@/lib/auth/gate";
import { PrintersScreen } from "@/features/backoffice/integrations";

export const dynamic = "force-dynamic";
export const metadata = { title: "Printers — RESTORA" };

export default function Page() {
  return gated("/settings/printers", () => <PrintersScreen />);
}
