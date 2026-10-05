import { gated } from "@/lib/auth/gate";
import { GRNDetail } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Goods receipt — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/procurement/grns/${id}`, () => <GRNDetail id={id} />);
}
