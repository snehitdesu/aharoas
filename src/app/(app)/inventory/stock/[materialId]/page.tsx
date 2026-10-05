import { gated } from "@/lib/auth/gate";
import { MaterialStockDetail } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock movement — RESTORA" };

export default async function Page({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  return gated(`/inventory/stock/${materialId}`, () => <MaterialStockDetail materialId={materialId} />);
}
