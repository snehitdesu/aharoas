import { gated } from "@/lib/auth/gate";
import { MenuItemDetail } from "@/features/backoffice/menu";

export const dynamic = "force-dynamic";
export const metadata = { title: "Menu item — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/menu/items/${id}`, () => <MenuItemDetail id={id} />);
}
