import { gated } from "@/lib/auth/gate";
import { MenuItemsScreen } from "@/features/backoffice/menu";

export const dynamic = "force-dynamic";
export const metadata = { title: "Menu items — Aharos" };

export default function Page() {
  return gated("/menu", () => <MenuItemsScreen />);
}
