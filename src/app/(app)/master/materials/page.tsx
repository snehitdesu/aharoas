import { gated } from "@/lib/auth/gate";
import { MaterialsScreen } from "@/features/backoffice/master";

export const dynamic = "force-dynamic";
export const metadata = { title: "Materials — RESTORA" };

export default function Page() {
  return gated("/master/materials", () => <MaterialsScreen />);
}
