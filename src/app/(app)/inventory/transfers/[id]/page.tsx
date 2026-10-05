import { gated } from "@/lib/auth/gate";
import { TransferDetail } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock transfer — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/inventory/transfers/${id}`, () => <TransferDetail id={id} />);
}
