import { gated } from "@/lib/auth/gate";
import { StockCountDetail } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock count — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/inventory/counts/${id}`, () => <StockCountDetail id={id} />);
}
