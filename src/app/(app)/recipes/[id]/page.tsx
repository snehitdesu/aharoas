import { gated } from "@/lib/auth/gate";
import { RecipeDetail } from "@/features/backoffice/recipes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recipe — Aharos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/recipes/${id}`, () => <RecipeDetail id={id} />);
}
