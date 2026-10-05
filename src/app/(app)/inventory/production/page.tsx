import { gated } from "@/lib/auth/gate";
import { ProductionScreen } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Production — RESTORA" };

export default function Page() {
  return gated("/inventory/production", () => <ProductionScreen />);
}
