import { gated } from "@/lib/auth/gate";
import { PurchaseOrderDetail } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchase order — Aharos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/procurement/purchase-orders/${id}`, () => <PurchaseOrderDetail id={id} />);
}
