import { gated } from "@/lib/auth/gate";
import { MenuCategoriesScreen } from "@/features/backoffice/menu";

export const dynamic = "force-dynamic";
export const metadata = { title: "Menu categories — RESTORA" };

export default function Page() {
  return gated("/menu/categories", () => <MenuCategoriesScreen />);
}
