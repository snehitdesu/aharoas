import { gated } from "@/lib/auth/gate";
import { WastageDetail } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wastage — Aharos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/inventory/wastage/${id}`, () => <WastageDetail id={id} />);
}
