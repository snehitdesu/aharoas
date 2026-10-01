import { gated } from "@/lib/auth/gate";
import { ProductionDetail } from "@/features/backoffice/inventory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Production batch — Aharos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/inventory/production/${id}`, () => <ProductionDetail id={id} />);
}
