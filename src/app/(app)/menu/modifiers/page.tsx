import { gated } from "@/lib/auth/gate";
import { ModifiersScreen } from "@/features/backoffice/menu";

export const dynamic = "force-dynamic";
export const metadata = { title: "Modifiers — Aharos" };

export default function Page() {
  return gated("/menu/modifiers", () => <ModifiersScreen />);
}
