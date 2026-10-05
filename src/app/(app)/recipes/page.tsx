import { gated } from "@/lib/auth/gate";
import { RecipesScreen } from "@/features/backoffice/recipes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recipes — RESTORA" };

export default function Page() {
  return gated("/recipes", () => <RecipesScreen />);
}
