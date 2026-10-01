import { gated } from "@/lib/auth/gate";
import { BillDetail } from "@/features/backoffice/procurement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchase bill — Aharos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/procurement/bills/${id}`, () => <BillDetail id={id} />);
}
